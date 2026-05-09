package main

import (
	"bufio"
	_ "embed"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

//go:embed index.html
var indexHTML []byte

var (
	rootPath   string
	statusMu   sync.RWMutex
	userStatus map[string]string // url -> user-set status
)

// ── Data types ────────────────────────────────────────────────────────────────

type Job struct {
	URL        string `json:"url"`
	Company    string `json:"company"`
	Title      string `json:"title"`
	Portal     string `json:"portal"`
	FirstSeen  string `json:"first_seen"`
	ScanStatus string `json:"scan_status"`
	UserStatus string `json:"user_status"` // interested/applying/applied/skip/""
}

type ScanEntry struct {
	URL       string `json:"url"`
	FirstSeen string `json:"first_seen"`
	Portal    string `json:"portal"`
	Title     string `json:"title"`
	Company   string `json:"company"`
	Status    string `json:"status"`
}

type Investor struct {
	Name    string   `json:"name"`
	Firm    string   `json:"firm"`
	Focus   []string `json:"focus"`
	Website string   `json:"website"`
	Contact string   `json:"contact"`
	Status  string   `json:"status"`
	Notes   string   `json:"notes"`
}

type Stats struct {
	TotalJobs     int            `json:"total_jobs"`
	ByPortal      map[string]int `json:"by_portal"`
	ByUserStatus  map[string]int `json:"by_user_status"`
	TopCompanies  []CompanyCount `json:"top_companies"`
	DailyActivity []DayCount     `json:"daily_activity"`
}

type CompanyCount struct {
	Company string `json:"company"`
	Count   int    `json:"count"`
}

type DayCount struct {
	Date  string `json:"date"`
	Count int    `json:"count"`
}

// ── Parsers ───────────────────────────────────────────────────────────────────

func parsePipelineMD() []Job {
	filePath := filepath.Join(rootPath, "data", "pipeline.md")
	f, err := os.Open(filePath)
	if err != nil {
		return nil
	}
	defer f.Close()

	var jobs []Job
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "- [") {
			continue
		}
		rest := strings.TrimPrefix(strings.TrimPrefix(strings.TrimPrefix(
			line, "- [x] "), "- [X] "), "- [ ] ")
		parts := strings.SplitN(rest, " | ", 3)
		if len(parts) < 2 {
			continue
		}
		j := Job{URL: strings.TrimSpace(parts[0])}
		if len(parts) >= 2 {
			j.Company = strings.TrimSpace(parts[1])
		}
		if len(parts) >= 3 {
			j.Title = strings.TrimSpace(parts[2])
		}
		jobs = append(jobs, j)
	}
	return jobs
}

func parseScanHistory() []ScanEntry {
	filePath := filepath.Join(rootPath, "data", "scan-history.tsv")
	f, err := os.Open(filePath)
	if err != nil {
		return nil
	}
	defer f.Close()

	r := csv.NewReader(f)
	r.Comma = '\t'
	r.LazyQuotes = true
	records, err := r.ReadAll()
	if err != nil {
		return nil
	}

	var entries []ScanEntry
	for i, rec := range records {
		if i == 0 {
			continue
		}
		if len(rec) < 5 {
			continue
		}
		e := ScanEntry{URL: rec[0], FirstSeen: rec[1], Portal: rec[2], Title: rec[3], Company: rec[4]}
		if len(rec) >= 6 {
			e.Status = rec[5]
		}
		entries = append(entries, e)
	}
	return entries
}

func buildJobs(pipeline []Job, scan []ScanEntry) []Job {
	scanMap := make(map[string]ScanEntry, len(scan))
	for _, e := range scan {
		scanMap[e.URL] = e
	}

	seen := make(map[string]bool)
	result := make([]Job, 0, len(pipeline))

	statusMu.RLock()
	defer statusMu.RUnlock()

	for _, j := range pipeline {
		if e, ok := scanMap[j.URL]; ok {
			j.Portal = e.Portal
			j.FirstSeen = e.FirstSeen
			j.ScanStatus = e.Status
			if j.Title == "" {
				j.Title = e.Title
			}
		}
		j.UserStatus = userStatus[j.URL]
		seen[j.URL] = true
		result = append(result, j)
	}
	// include scan entries not in pipeline.md
	for _, e := range scan {
		if seen[e.URL] {
			continue
		}
		result = append(result, Job{
			URL: e.URL, Company: e.Company, Title: e.Title,
			Portal: e.Portal, FirstSeen: e.FirstSeen,
			ScanStatus: e.Status, UserStatus: userStatus[e.URL],
		})
	}
	return result
}

func computeStats(jobs []Job) Stats {
	s := Stats{
		TotalJobs:    len(jobs),
		ByPortal:     make(map[string]int),
		ByUserStatus: make(map[string]int),
	}
	compMap := make(map[string]int)
	dayMap := make(map[string]int)

	for _, j := range jobs {
		if j.Portal != "" {
			s.ByPortal[j.Portal]++
		}
		us := j.UserStatus
		if us == "" {
			us = "unreviewed"
		}
		s.ByUserStatus[us]++
		if j.Company != "" {
			compMap[j.Company]++
		}
		if j.FirstSeen != "" {
			day := j.FirstSeen
			if len(day) > 10 {
				day = day[:10]
			}
			dayMap[day]++
		}
	}

	type kv struct {
		k string
		v int
	}
	var sorted []kv
	for k, v := range compMap {
		sorted = append(sorted, kv{k, v})
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].v > sorted[j].v })
	for i, kv := range sorted {
		if i >= 25 {
			break
		}
		s.TopCompanies = append(s.TopCompanies, CompanyCount{kv.k, kv.v})
	}

	var days []string
	for d := range dayMap {
		days = append(days, d)
	}
	sort.Strings(days)
	if len(days) > 60 {
		days = days[len(days)-60:]
	}
	for _, d := range days {
		s.DailyActivity = append(s.DailyActivity, DayCount{d, dayMap[d]})
	}
	return s
}

// ── Status persistence ────────────────────────────────────────────────────────

func statusFilePath() string {
	return filepath.Join(rootPath, "data", "job-status.json")
}

func loadUserStatus() {
	data, err := os.ReadFile(statusFilePath())
	if err != nil {
		userStatus = make(map[string]string)
		return
	}
	if err := json.Unmarshal(data, &userStatus); err != nil {
		userStatus = make(map[string]string)
	}
}

func saveUserStatus() error {
	data, err := json.MarshalIndent(userStatus, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(statusFilePath(), data, 0644)
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

func jsonOK(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(v)
}

func handleSetStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", 405)
		return
	}
	var req struct {
		URL    string `json:"url"`
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	statusMu.Lock()
	if req.Status == "" {
		delete(userStatus, req.URL)
	} else {
		userStatus[req.URL] = req.Status
	}
	saveUserStatus()
	statusMu.Unlock()
	jsonOK(w, map[string]string{"ok": "true"})
}

func openBrowser(url string) {
	time.Sleep(400 * time.Millisecond)
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	cmd.Run()
}

func main() {
	pathFlag := flag.String("path", ".", "Path to career-ops directory")
	portFlag := flag.Int("port", 7410, "HTTP port")
	flag.Parse()
	rootPath = *pathFlag

	loadUserStatus()

	// Pre-parse
	pipeline := parsePipelineMD()
	scan := parseScanHistory()

	// Profile
	var profile map[string]interface{}
	if raw, err := os.ReadFile(filepath.Join(rootPath, "config", "profile.yml")); err == nil {
		yaml.Unmarshal(raw, &profile)
	}

	// CV
	cvContent := ""
	if raw, err := os.ReadFile(filepath.Join(rootPath, "cv.md")); err == nil {
		cvContent = string(raw)
	}

	// Investors
	type InvFile struct {
		Investors []Investor `yaml:"investors"`
	}
	var invFile InvFile
	if raw, err := os.ReadFile(filepath.Join(rootPath, "data", "investors.yml")); err == nil {
		yaml.Unmarshal(raw, &invFile)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexHTML)
	})

	mux.HandleFunc("/api/jobs", func(w http.ResponseWriter, r *http.Request) {
		jobs := buildJobs(pipeline, scan)
		jsonOK(w, jobs)
	})

	mux.HandleFunc("/api/stats", func(w http.ResponseWriter, r *http.Request) {
		jobs := buildJobs(pipeline, scan)
		jsonOK(w, computeStats(jobs))
	})

	mux.HandleFunc("/api/profile", func(w http.ResponseWriter, r *http.Request) {
		jsonOK(w, profile)
	})

	mux.HandleFunc("/api/cv", func(w http.ResponseWriter, r *http.Request) {
		jsonOK(w, cvContent)
	})

	mux.HandleFunc("/api/investors", func(w http.ResponseWriter, r *http.Request) {
		jsonOK(w, invFile.Investors)
	})

	mux.HandleFunc("/api/scan-history", func(w http.ResponseWriter, r *http.Request) {
		jsonOK(w, scan)
	})

	mux.HandleFunc("/api/status", handleSetStatus)

	addr := fmt.Sprintf(":%d", *portFlag)
	url := fmt.Sprintf("http://localhost%s", addr)
	fmt.Printf("\n  Career-Ops Dashboard  →  %s\n\n", url)
	go openBrowser(url)
	log.Fatal(http.ListenAndServe(addr, mux))
}
