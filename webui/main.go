package main

import (
	"bufio"
	"bytes"
	_ "embed"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"math"
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
	serverPort int // HTTP port the webui listens on (used to build OAuth callback URLs)
	statusMu   sync.RWMutex
	userStatus map[string]string // url -> user-set status
	userNotes  map[string]string // url -> notes

	enrichMu     sync.Mutex
	enrichActive = make(map[string]bool)

	// portalsRawMu guards portalsRaw which is read by /api/portals and written
	// by /api/portals/update-queries from different goroutines.
	portalsRawMu sync.RWMutex
	// portalsRaw holds the in-memory parsed portals.yml.
	portalsRaw interface{}
)

// ── Data types ─────────────────────────────────────────────────────────────────

type Job struct {
	URL        string `json:"url"`
	Company    string `json:"company"`
	Title      string `json:"title"`
	Portal     string `json:"portal"`
	FirstSeen  string `json:"first_seen"`
	ScanStatus string `json:"scan_status"`
	UserStatus string `json:"user_status"`
	Notes      string `json:"notes"`
	Score      string `json:"score"`
	Source     string `json:"source"`
}

type ScanEntry struct {
	URL       string `json:"url"`
	FirstSeen string `json:"first_seen"`
	Portal    string `json:"portal"`
	Title     string `json:"title"`
	Company   string `json:"company"`
	Status    string `json:"status"`
	Source    string `json:"source"`
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
	NewToday      int            `json:"new_today"`
	ByPortal      map[string]int `json:"by_portal"`
	BySource      map[string]int `json:"by_source"`
	ByUserStatus  map[string]int `json:"by_user_status"`
	TopCompanies  []CompanyCount `json:"top_companies"`
	DailyActivity []DayCount     `json:"daily_activity"`
	AvgScore      float64        `json:"avg_score"`
}

type CompanyCount struct {
	Company string `json:"company"`
	Count   int    `json:"count"`
}

type DayCount struct {
	Date  string `json:"date"`
	Count int    `json:"count"`
}

type SavedSearch struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Boards    []string `json:"boards"`
	Queries   []string `json:"queries"`
	Location  string   `json:"location"`
	MaxResult int      `json:"max_results"`
	LastRun   string   `json:"last_run"`
	Results   int      `json:"results"`
}

type AutoApplyConfig struct {
	MinScore       float64  `json:"min_score"`
	MinGDRating    float64  `json:"min_gd_rating"`
	MaxPerDay      int      `json:"max_per_day"`
	RequireRemote  bool     `json:"require_remote"`
	ExcludeCompany []string `json:"exclude_companies"`
}


// ── Company Location + Distance (Feature 3) ───────────────────────────────────

type CompanyLocation struct {
	Name       string  `json:"name"`
	City       string  `json:"city"`
	Address    string  `json:"address"`
	Lat        float64 `json:"lat"`
	Lng        float64 `json:"lng"`
	DistanceMi float64 `json:"distance_mi"`
}

// Cole's home base: Arlington, TX
const homeBaseLat = 32.7357
const homeBaseLng = -97.1081

func haversine(lat1, lng1, lat2, lng2 float64) float64 {
	const R = 3958.8 // Earth radius miles
	dLat := (lat2 - lat1) * math.Pi / 180
	dLng := (lng2 - lng1) * math.Pi / 180
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
		math.Sin(dLng/2)*math.Sin(dLng/2)
	return R * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
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
		// Detect source from URL
		j.Source = detectSource(j.URL)
		jobs = append(jobs, j)
	}
	return jobs
}

func detectSource(url string) string {
	url = strings.ToLower(url)
	if strings.Contains(url, "indeed.com") {
		return "indeed"
	}
	if strings.Contains(url, "linkedin.com") {
		return "linkedin"
	}
	if strings.Contains(url, "glassdoor.com") {
		return "glassdoor"
	}
	if strings.Contains(url, "ziprecruiter.com") {
		return "ziprecruiter"
	}
	return "scan"
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
		e := ScanEntry{
			URL:       rec[0],
			FirstSeen: rec[1],
			Portal:    rec[2],
			Title:     rec[3],
			Company:   rec[4],
		}
		if len(rec) >= 6 {
			e.Status = rec[5]
		}
		// Detect source from portal field or URL
		if strings.Contains(e.Portal, "indeed") {
			e.Source = "indeed"
		} else if strings.Contains(e.Portal, "linkedin") {
			e.Source = "linkedin"
		} else if strings.Contains(e.Portal, "glassdoor") {
			e.Source = "glassdoor"
		} else if strings.Contains(e.Portal, "zip") {
			e.Source = "ziprecruiter"
		} else {
			e.Source = "scan"
		}
		entries = append(entries, e)
	}
	return entries
}

// findScore looks for a report file for the given company slug and extracts the score.
// scoreRe matches the score line in evaluation reports. Tolerates both
// `**Score:** 4.2/5` (canonical, see modes/oferta.md) and `**Score: 4.2/5**`.
var scoreRe = regexp.MustCompile(`(?i)\*\*\s*Score:?\s*\*{0,2}\s*([\d.]+)\s*/\s*5`)

// buildScoreMap scans reports/ once and returns slug -> score. Report files are
// named {###}-{company-slug}-{date}.md, so the company slug is matched as a
// substring of the filename.
func buildScoreMap() map[string]string {
	scores := map[string]string{}
	// Reports live in reports/ at the project root (see AGENTS.md), not data/reports.
	reportsDir := filepath.Join(rootPath, "reports")
	entries, err := os.ReadDir(reportsDir)
	if err != nil {
		return scores
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".md") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(reportsDir, name))
		if err != nil {
			continue
		}
		if m := scoreRe.FindSubmatch(data); m != nil {
			// Strip the leading number prefix (e.g. "007-") and trailing date.
			key := strings.TrimSuffix(name, ".md")
			scores[key] = string(m[1])
		}
	}
	return scores
}

// scoreForCompany looks up a company's score in a prebuilt map by matching its
// slug against report filename keys.
func scoreForCompany(scores map[string]string, company string) string {
	slug := slugify(company)
	if slug == "" {
		return ""
	}
	for key, score := range scores {
		if strings.Contains(key, slug) {
			return score
		}
	}
	return ""
}

func slugify(s string) string {
	s = strings.ToLower(s)
	re := regexp.MustCompile(`[^a-z0-9]+`)
	s = re.ReplaceAllString(s, "-")
	return strings.Trim(s, "-")
}

// guestDataDir returns "data/guest" if guest mode is requested, otherwise "data".
func guestDataDir(r *http.Request) string {
	if r.URL.Query().Get("guest") == "true" || r.Header.Get("X-Guest-Mode") == "true" {
		return "data/guest"
	}
	return "data"
}

func buildJobs(pipeline []Job, scan []ScanEntry) []Job {
	scanMap := make(map[string]ScanEntry, len(scan))
	for _, e := range scan {
		scanMap[e.URL] = e
	}

	seen := make(map[string]bool)
	result := make([]Job, 0, len(pipeline))

	// Scan reports/ once instead of once per job.
	scoreMap := buildScoreMap()

	statusMu.RLock()
	defer statusMu.RUnlock()

	for _, j := range pipeline {
		if e, ok := scanMap[j.URL]; ok {
			j.Portal = e.Portal
			j.FirstSeen = e.FirstSeen
			j.ScanStatus = e.Status
			j.Source = e.Source
			if j.Title == "" {
				j.Title = e.Title
			}
		}
		j.UserStatus = userStatus[j.URL]
		j.Notes = userNotes[j.URL]
		j.Score = scoreForCompany(scoreMap, j.Company)
		seen[j.URL] = true
		result = append(result, j)
	}
	for _, e := range scan {
		if seen[e.URL] {
			continue
		}
		result = append(result, Job{
			URL:        e.URL,
			Company:    e.Company,
			Title:      e.Title,
			Portal:     e.Portal,
			FirstSeen:  e.FirstSeen,
			ScanStatus: e.Status,
			UserStatus: userStatus[e.URL],
			Notes:      userNotes[e.URL],
			Source:     e.Source,
			Score:      scoreForCompany(scoreMap, e.Company),
		})
	}
	return result
}

func computeStats(jobs []Job) Stats {
	today := time.Now().Format("2006-01-02")
	s := Stats{
		TotalJobs:    len(jobs),
		ByPortal:     make(map[string]int),
		BySource:     make(map[string]int),
		ByUserStatus: make(map[string]int),
	}
	compMap := make(map[string]int)
	dayMap := make(map[string]int)
	scoreSum := 0.0
	scoreCount := 0

	for _, j := range jobs {
		if j.Portal != "" {
			s.ByPortal[j.Portal]++
		}
		src := j.Source
		if src == "" {
			src = "scan"
		}
		s.BySource[src]++
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
			if day == today {
				s.NewToday++
			}
		}
		if j.Score != "" {
			var sc float64
			fmt.Sscanf(j.Score, "%f", &sc)
			scoreSum += sc
			scoreCount++
		}
	}
	if scoreCount > 0 {
		s.AvgScore = scoreSum / float64(scoreCount)
	}

	type kv struct{ k string; v int }
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

// ── Persistence ───────────────────────────────────────────────────────────────

func statusFilePath() string { return filepath.Join(rootPath, "data", "job-status.json") }
func notesFilePath() string  { return filepath.Join(rootPath, "data", "job-notes.json") }

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

func loadUserNotes() {
	data, err := os.ReadFile(notesFilePath())
	if err != nil {
		userNotes = make(map[string]string)
		return
	}
	if err := json.Unmarshal(data, &userNotes); err != nil {
		userNotes = make(map[string]string)
	}
}

func saveUserStatus() error {
	data, _ := json.MarshalIndent(userStatus, "", "  ")
	return os.WriteFile(statusFilePath(), data, 0644)
}

func saveUserNotes() error {
	data, _ := json.MarshalIndent(userNotes, "", "  ")
	return os.WriteFile(notesFilePath(), data, 0644)
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

func sseHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")
}

// sseRun streams a child process's combined stdout+stderr as SSE events.
// It respects r.Context(): when the client disconnects the child is killed,
// preventing goroutine and process leaks.
func sseRun(w http.ResponseWriter, r *http.Request, cmd *exec.Cmd) {
	ctx := r.Context()
	sseHeaders(w)
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", 500)
		return
	}

	// FIX: check pipe creation errors — nil pipes cause a panic in MultiReader.
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		fmt.Fprintf(w, "data: ERROR: %s\n\n", err.Error())
		fl.Flush()
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		fmt.Fprintf(w, "data: ERROR: %s\n\n", err.Error())
		fl.Flush()
		return
	}

	if err := cmd.Start(); err != nil {
		fmt.Fprintf(w, "data: ERROR: %s\n\n", err.Error())
		fl.Flush()
		return
	}

	// FIX: kill child when client disconnects to prevent process/goroutine leak.
	go func() {
		<-ctx.Done()
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
	}()

	combined := io.MultiReader(stdout, stderr)
	sc := bufio.NewScanner(combined)
	for sc.Scan() {
		// FIX: bail out of scan loop immediately on client disconnect.
		select {
		case <-ctx.Done():
			return
		default:
		}
		line := strings.ReplaceAll(sc.Text(), "\n", " ")
		fmt.Fprintf(w, "data: %s\n\n", line)
		fl.Flush()
	}
	cmd.Wait()
	// Only send __DONE__ if client is still connected.
	select {
	case <-ctx.Done():
		return
	default:
	}
	fmt.Fprintf(w, "data: __DONE__\n\n")
	fl.Flush()
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

func jsonOK(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(v)
}

func cors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

// ── Handlers ──────────────────────────────────────────────────────────────────

func handleSetStatus(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == http.MethodOptions {
		return
	}
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
	// FIX: surface save errors instead of silently ignoring them.
	saveErr := saveUserStatus()
	statusMu.Unlock()
	if saveErr != nil {
		http.Error(w, "failed to persist status: "+saveErr.Error(), 500)
		return
	}
	jsonOK(w, map[string]string{"ok": "true"})
}

func handleSetNotes(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", 405)
		return
	}
	var req struct {
		URL   string `json:"url"`
		Notes string `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	statusMu.Lock()
	if req.Notes == "" {
		delete(userNotes, req.URL)
	} else {
		userNotes[req.URL] = req.Notes
	}
	// FIX: surface save errors instead of silently ignoring them.
	saveErr := saveUserNotes()
	statusMu.Unlock()
	if saveErr != nil {
		http.Error(w, "failed to persist notes: "+saveErr.Error(), 500)
		return
	}
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

func safeSlug(s string) bool {
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
			return false
		}
	}
	return true
}

// ── Settings ──────────────────────────────────────────────────────────────────

func settingsFilePath() string { return filepath.Join(rootPath, "data", "settings.json") }

func loadSettings() map[string]interface{} {
	data, err := os.ReadFile(settingsFilePath())
	if err != nil {
		return make(map[string]interface{})
	}
	var v map[string]interface{}
	if err := json.Unmarshal(data, &v); err != nil {
		return make(map[string]interface{})
	}
	return v
}

func saveSettings(settings map[string]interface{}) error {
	if err := os.MkdirAll(filepath.Dir(settingsFilePath()), 0755); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(settings, "", "  ")
	return os.WriteFile(settingsFilePath(), data, 0644)
}

// ── Background daemon ───────────────────────────────────────────────────────────
//
// Auto-evaluates pipeline jobs (filling the Score column on its own) and runs
// enrichment in the background. Controlled by settings keys:
//   daemonEnabled     bool   — default true
//   daemonModel       string — default gemini-3-flash-preview:cloud
//   daemonIntervalMin number — default 4
// The toggle lives in settings.json so it persists across restarts.

var (
	daemonMu     sync.Mutex
	daemonLastRun    string
	daemonLastResult string
	daemonRunning    bool
)

const defaultDaemonModel = "gemini-3-flash-preview:cloud"

// daemonIsEnabled reports the toggle state; a missing key means ON (default).
func daemonIsEnabled(settings map[string]interface{}) bool {
	if v, ok := settings["daemonEnabled"].(bool); ok {
		return v
	}
	return true
}

// lastLine returns the last non-empty line of s (for compact status messages).
func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if t := strings.TrimSpace(lines[i]); t != "" {
			return t
		}
	}
	return ""
}

// daemonTick evaluates the next unevaluated job, or — if the queue is empty —
// enriches one more company.
func daemonTick() {
	daemonMu.Lock()
	if daemonRunning {
		daemonMu.Unlock()
		return // previous tick still running; skip
	}
	daemonRunning = true
	daemonMu.Unlock()
	defer func() {
		daemonMu.Lock()
		daemonRunning = false
		daemonMu.Unlock()
	}()

	evalCmd := exec.Command("node", "evaluate.mjs", "--next")
	evalCmd.Dir = rootPath
	out, _ := evalCmd.CombinedOutput()
	text := string(out)

	var result string
	if strings.Contains(text, "NOTHING_TO_EVALUATE") {
		enrichCmd := exec.Command("node", "enrich.mjs", "--limit", "1", "--skip-contacts", "--headless")
		enrichCmd.Dir = rootPath
		eout, _ := enrichCmd.CombinedOutput()
		result = "enrich · " + lastLine(string(eout))
	} else {
		result = "evaluate · " + lastLine(text)
	}

	daemonMu.Lock()
	daemonLastRun = time.Now().Format("2006-01-02 15:04:05")
	daemonLastResult = result
	daemonMu.Unlock()
}

// runDaemonLoop is the background worker started once at webui launch.
func runDaemonLoop() {
	for {
		intervalMin := 4
		if v, ok := loadSettings()["daemonIntervalMin"].(float64); ok && v >= 1 {
			intervalMin = int(v)
		}
		time.Sleep(time.Duration(intervalMin) * time.Minute)

		if daemonIsEnabled(loadSettings()) {
			daemonTick()
		}
	}
}

// ── AI helpers ────────────────────────────────────────────────────────────────

// jsonToken encodes a string as a JSON string literal (safe for SSE data lines).
func jsonToken(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func buildSystemMessage(profile map[string]interface{}, cv string, totalJobs, appliedJobs int, targetRoles []string) string {
	name := "the candidate"
	headline := ""
	var superpowers []string
	compRange := ""

	if profile != nil {
		if cand, ok := profile["candidate"].(map[string]interface{}); ok {
			if n, ok := cand["full_name"].(string); ok {
				name = n
			}
		}
		if narr, ok := profile["narrative"].(map[string]interface{}); ok {
			if h, ok := narr["headline"].(string); ok {
				headline = h
			}
			if sp, ok := narr["superpowers"].([]interface{}); ok {
				for _, s := range sp {
					if str, ok := s.(string); ok {
						superpowers = append(superpowers, "• "+str)
					}
				}
			}
		}
		if comp, ok := profile["compensation"].(map[string]interface{}); ok {
			if r, ok := comp["target_range"].(string); ok {
				compRange = r
			}
		}
	}

	cvSummary := cv
	if len(cvSummary) > 500 {
		cvSummary = cvSummary[:500] + "..."
	}

	rolesStr := strings.Join(targetRoles, ", ")
	powersStr := strings.Join(superpowers, "\n")

	return fmt.Sprintf(`You are a career advisor with full context about this job seeker. Here is their profile:

Name: %s
Profile: %s
Target roles: %s
Compensation range: %s

Key skills and superpowers:
%s

Current job search status: %d jobs in pipeline, %d applied, targeting roles like %s.

CV summary (first 500 chars):
%s

Help them explore career opportunities, identify transferable skills, suggest unconventional paths, and answer questions about career strategy. When you suggest specific job titles or industries to explore, format them as actionable items using this exact syntax: [ACTION:search:"query here"] so the UI can extract them as clickable buttons.`,
		name, headline, rolesStr, compRange, powersStr, totalJobs, appliedJobs, rolesStr, cvSummary)
}

// FIX: accept *http.Request so we can propagate context for client-disconnect
// cancellation, preventing a goroutine stuck reading a dead connection.
func doStreamOllama(w http.ResponseWriter, r *http.Request, fl http.Flusher, model string, messages []map[string]interface{}, systemMsg string) {
	allMessages := messages
	if systemMsg != "" {
		allMessages = append([]map[string]interface{}{{"role": "system", "content": systemMsg}}, messages...)
	}

	reqBody := map[string]interface{}{
		"model":    model,
		"messages": allMessages,
		"stream":   true,
	}
	bodyBytes, _ := json.Marshal(reqBody)

	// FIX: use NewRequestWithContext so the HTTP call is cancelled when the
	// SSE client disconnects.
	httpReq, err := http.NewRequestWithContext(r.Context(), "POST", "http://localhost:11434/api/chat", bytes.NewReader(bodyBytes))
	if err != nil {
		fmt.Fprintf(w, "data: %s\n\ndata: __AI_DONE__\n\n", jsonToken("Error: "+err.Error()))
		fl.Flush()
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		fmt.Fprintf(w, "data: %s\n\ndata: __AI_DONE__\n\n", jsonToken("Error connecting to Ollama: "+err.Error()))
		fl.Flush()
		return
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 64*1024)
	for scanner.Scan() {
		// FIX: bail immediately on client disconnect.
		select {
		case <-r.Context().Done():
			return
		default:
		}
		line := scanner.Text()
		if line == "" {
			continue
		}
		var chunk struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			Done bool `json:"done"`
		}
		if err := json.Unmarshal([]byte(line), &chunk); err != nil {
			continue
		}
		if chunk.Message.Content != "" {
			fmt.Fprintf(w, "data: %s\n\n", jsonToken(chunk.Message.Content))
			fl.Flush()
		}
		if chunk.Done {
			break
		}
	}
	fmt.Fprintf(w, "data: __AI_DONE__\n\n")
	fl.Flush()
}

// FIX: accept *http.Request to propagate context for client-disconnect cancellation.
func doStreamClaude(w http.ResponseWriter, r *http.Request, fl http.Flusher, model string, messages []map[string]interface{}, systemMsg string, apiKey string) {
	type ClaudeMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	var claudeMsgs []ClaudeMsg
	for _, m := range messages {
		role, _ := m["role"].(string)
		content, _ := m["content"].(string)
		if role == "user" || role == "assistant" {
			claudeMsgs = append(claudeMsgs, ClaudeMsg{Role: role, Content: content})
		}
	}

	reqBody := map[string]interface{}{
		"model":      model,
		"max_tokens": 2048,
		"stream":     true,
		"messages":   claudeMsgs,
	}
	if systemMsg != "" {
		reqBody["system"] = systemMsg
	}

	bodyBytes, _ := json.Marshal(reqBody)

	// FIX: use NewRequestWithContext so the HTTP call is cancelled when the
	// SSE client disconnects, preventing a goroutine stuck on a dead stream.
	req, err := http.NewRequestWithContext(r.Context(), "POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(bodyBytes))
	if err != nil {
		fmt.Fprintf(w, "data: %s\n\ndata: __AI_DONE__\n\n", jsonToken("Error: "+err.Error()))
		fl.Flush()
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(w, "data: %s\n\ndata: __AI_DONE__\n\n", jsonToken("Error connecting to Claude: "+err.Error()))
		fl.Flush()
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		errBody, _ := io.ReadAll(resp.Body)
		fmt.Fprintf(w, "data: %s\n\ndata: __AI_DONE__\n\n", jsonToken("Claude API error "+resp.Status+": "+string(errBody)))
		fl.Flush()
		return
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 64*1024)
	var currentEvent string
	for scanner.Scan() {
		// FIX: bail immediately when client disconnects.
		select {
		case <-r.Context().Done():
			return
		default:
		}
		line := scanner.Text()
		if strings.HasPrefix(line, "event: ") {
			currentEvent = strings.TrimPrefix(line, "event: ")
		} else if strings.HasPrefix(line, "data: ") {
			data := strings.TrimPrefix(line, "data: ")
			if currentEvent == "content_block_delta" {
				var delta struct {
					Delta struct {
						Type string `json:"type"`
						Text string `json:"text"`
					} `json:"delta"`
				}
				if err := json.Unmarshal([]byte(data), &delta); err == nil && delta.Delta.Text != "" {
					fmt.Fprintf(w, "data: %s\n\n", jsonToken(delta.Delta.Text))
					fl.Flush()
				}
			} else if currentEvent == "message_stop" {
				break
			}
		}
	}
	fmt.Fprintf(w, "data: __AI_DONE__\n\n")
	fl.Flush()
}

func handleGuestReset(w http.ResponseWriter, r *http.Request) {
	guestDir := filepath.Join(rootPath, "data", "guest")
	os.RemoveAll(guestDir)
	os.MkdirAll(filepath.Join(guestDir, "intel"), 0755)
	os.WriteFile(filepath.Join(guestDir, "pipeline.md"), []byte("# Pipeline\n\n## Pendientes\n\n## En Progreso\n\n## Completado\n"), 0644)
	os.WriteFile(filepath.Join(guestDir, "applications.md"), []byte("# Applications\n"), 0644)
	os.WriteFile(filepath.Join(guestDir, "intel-index.json"), []byte("{}"), 0644)
	os.WriteFile(filepath.Join(guestDir, "work-preferences.json"), []byte("{}"), 0644)
	os.WriteFile(filepath.Join(guestDir, "work-persona.json"), []byte("{}"), 0644)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "reset", "dir": guestDir})
}

func handleGuestStatus(w http.ResponseWriter, r *http.Request) {
	isGuest := r.URL.Query().Get("guest") == "true"
	dataDir := "data"
	if isGuest {
		dataDir = "data/guest"
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"active":   isGuest,
		"data_dir": dataDir,
	})
}

func main() {
	pathFlag := flag.String("path", ".", "Path to career-ops directory")
	portFlag := flag.Int("port", 7410, "HTTP port")
	flag.Parse()
	rootPath = *pathFlag
	serverPort = *portFlag

	loadUserStatus()
	loadUserNotes()

	// Pre-parse data at startup
	pipeline := parsePipelineMD()
	scan := parseScanHistory()

	var profile map[string]interface{}
	if raw, err := os.ReadFile(filepath.Join(rootPath, "config", "profile.yml")); err == nil {
		yaml.Unmarshal(raw, &profile)
	}

	cvContent := ""
	if raw, err := os.ReadFile(filepath.Join(rootPath, "cv.md")); err == nil {
		cvContent = string(raw)
	}

	type InvFile struct {
		Investors []Investor `yaml:"investors"`
	}
	var invFile InvFile
	if raw, err := os.ReadFile(filepath.Join(rootPath, "data", "investors.yml")); err == nil {
		yaml.Unmarshal(raw, &invFile)
	}

	// Load portals.yml for settings tab (single-goroutine startup — no lock needed yet).
	if raw, err := os.ReadFile(filepath.Join(rootPath, "portals.yml")); err == nil {
		yaml.Unmarshal(raw, &portalsRaw)
	}

	mux := http.NewServeMux()

	// ── Static ─────────────────────────────────────────────────────────────────
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexHTML)
	})

	// ── Core data endpoints ────────────────────────────────────────────────────
	mux.HandleFunc("/api/jobs", func(w http.ResponseWriter, r *http.Request) {
		// Re-parse on each request so new scan results appear without restart
		p := parsePipelineMD()
		s := parseScanHistory()
		jobs := buildJobs(p, s)
		jsonOK(w, jobs)
	})

	mux.HandleFunc("/api/stats", func(w http.ResponseWriter, r *http.Request) {
		p := parsePipelineMD()
		s := parseScanHistory()
		jobs := buildJobs(p, s)
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
		jsonOK(w, parseScanHistory())
	})

	mux.HandleFunc("/api/portals", func(w http.ResponseWriter, r *http.Request) {
		// FIX: guard portalsRaw read — it can be written concurrently by /api/portals/update-queries.
		portalsRawMu.RLock()
		val := portalsRaw
		portalsRawMu.RUnlock()
		jsonOK(w, val)
	})

	mux.HandleFunc("/api/status", handleSetStatus)
	mux.HandleFunc("/api/notes", handleSetNotes)

	// ── Intel endpoints ────────────────────────────────────────────────────────
	mux.HandleFunc("/api/intel", func(w http.ResponseWriter, r *http.Request) {
		data, err := os.ReadFile(filepath.Join(rootPath, "data", "intel-index.json"))
		if err != nil {
			jsonOK(w, map[string]interface{}{})
			return
		}
		var v interface{}
		if err := json.Unmarshal(data, &v); err != nil {
			http.Error(w, "invalid intel-index.json", 500)
			return
		}
		jsonOK(w, v)
	})

	mux.HandleFunc("/api/intel/", func(w http.ResponseWriter, r *http.Request) {
		slug := strings.TrimPrefix(r.URL.Path, "/api/intel/")
		slug = strings.Trim(slug, "/")
		if !safeSlug(slug) {
			http.Error(w, "invalid slug", 400)
			return
		}
		data, err := os.ReadFile(filepath.Join(rootPath, "data", "intel", slug+".json"))
		if err != nil {
			http.Error(w, "intel not found", 404)
			return
		}
		var v interface{}
		json.Unmarshal(data, &v)
		jsonOK(w, v)
	})

	// ── Enrich endpoints ───────────────────────────────────────────────────────
	mux.HandleFunc("/api/enrich", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", 405)
			return
		}
		var req struct{ Slug string `json:"slug"` }
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Slug == "" {
			http.Error(w, "missing slug", 400)
			return
		}
		if !safeSlug(req.Slug) {
			http.Error(w, "invalid slug", 400)
			return
		}
		enrichMu.Lock()
		if enrichActive[req.Slug] {
			enrichMu.Unlock()
			http.Error(w, "already enriching", 409)
			return
		}
		enrichActive[req.Slug] = true
		enrichMu.Unlock()
		defer func() {
			enrichMu.Lock()
			delete(enrichActive, req.Slug)
			enrichMu.Unlock()
		}()

		cmd := exec.Command("node", "enrich.mjs", "--company", req.Slug, "--skip-contacts")
		cmd.Dir = rootPath
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			http.Error(w, "enrichment failed", 500)
			return
		}
		data, err := os.ReadFile(filepath.Join(rootPath, "data", "intel", req.Slug+".json"))
		if err != nil {
			jsonOK(w, map[string]string{"ok": "true"})
			return
		}
		var v interface{}
		json.Unmarshal(data, &v)
		jsonOK(w, v)
	})

	// POST /api/enrich/all — SSE stream
	mux.HandleFunc("/api/enrich/all", func(w http.ResponseWriter, r *http.Request) {
		cmd := exec.Command("node", "enrich.mjs")
		cmd.Dir = rootPath
		sseRun(w, r, cmd)
	})

	// POST /api/enrich/company?slug=X — SSE stream for single company
	mux.HandleFunc("/api/enrich/company", func(w http.ResponseWriter, r *http.Request) {
		slug := r.URL.Query().Get("slug")
		if slug == "" || !safeSlug(slug) {
			http.Error(w, "invalid slug", 400)
			return
		}
		cmd := exec.Command("node", "enrich.mjs", "--company", slug)
		cmd.Dir = rootPath
		sseRun(w, r, cmd)
	})

	// ── Scan / Search SSE endpoints ────────────────────────────────────────────
	mux.HandleFunc("/api/scan/run", func(w http.ResponseWriter, r *http.Request) {
		cmd := exec.Command("node", "scan.mjs")
		cmd.Dir = rootPath
		sseRun(w, r, cmd)
	})

	mux.HandleFunc("/api/search/run", func(w http.ResponseWriter, r *http.Request) {
		args := []string{"search.mjs"}
		if boards := r.URL.Query().Get("boards"); boards != "" {
			args = append(args, "--boards", boards)
		}
		if query := r.URL.Query().Get("query"); query != "" {
			args = append(args, "--query", query)
		}
		if limit := r.URL.Query().Get("limit"); limit != "" {
			args = append(args, "--limit", limit)
		}
		if locMode := r.URL.Query().Get("location_mode"); locMode != "" {
			args = append(args, "--location-mode", locMode)
		}
		if extraPos := r.URL.Query().Get("extra_positive"); extraPos != "" {
			args = append(args, "--extra-positive", extraPos)
		}
		if extraNeg := r.URL.Query().Get("extra_negative"); extraNeg != "" {
			args = append(args, "--extra-negative", extraNeg)
		}
		cmd := exec.Command("node", args...)
		cmd.Dir = rootPath
		sseRun(w, r, cmd)
	})

	// ── Apply endpoints ────────────────────────────────────────────────────────
	mux.HandleFunc("/api/apply/dry-run", func(w http.ResponseWriter, r *http.Request) {
		url := r.URL.Query().Get("url")
		if url == "" {
			http.Error(w, "missing url", 400)
			return
		}
		cmd := exec.Command("node", "apply-engine/index.mjs", "--url", url, "--dry-run")
		cmd.Dir = rootPath
		sseRun(w, r, cmd)
	})

	mux.HandleFunc("/api/apply/submit", func(w http.ResponseWriter, r *http.Request) {
		url := r.URL.Query().Get("url")
		if url == "" {
			http.Error(w, "missing url", 400)
			return
		}
		cmd := exec.Command("node", "apply-engine/index.mjs", "--url", url, "--submit")
		cmd.Dir = rootPath
		sseRun(w, r, cmd)
	})

	mux.HandleFunc("/api/apply/auto", func(w http.ResponseWriter, r *http.Request) {
		// Read auto-apply config and run through eligible jobs
		cfgData, err := os.ReadFile(filepath.Join(rootPath, "data", "auto-apply-config.json"))
		if err != nil {
			fmt.Fprintf(w, "data: No auto-apply config found. Configure it first.\n\n")
			fmt.Fprintf(w, "data: __DONE__\n\n")
			return
		}
		var cfg AutoApplyConfig
		json.Unmarshal(cfgData, &cfg)

		sseHeaders(w)
		fl, ok := w.(http.Flusher)
		if !ok {
			return
		}
		fmt.Fprintf(w, "data: Auto-apply config loaded. Min score: %.1f, Min GD: %.1f\n\n", cfg.MinScore, cfg.MinGDRating)
		fl.Flush()
		fmt.Fprintf(w, "data: __DONE__\n\n")
		fl.Flush()
	})

	// ── CV endpoints ───────────────────────────────────────────────────────────
	mux.HandleFunc("/api/cv/customize", func(w http.ResponseWriter, r *http.Request) {
		jobURL := r.URL.Query().Get("url")
		if jobURL == "" {
			http.Error(w, "missing url", 400)
			return
		}
		args := []string{"apply-engine/index.mjs", "--url", jobURL, "--dry-run", "--cv-only"}
		cmd := exec.Command("node", args...)
		cmd.Dir = rootPath
		sseRun(w, r, cmd)
	})

	mux.HandleFunc("/api/cv/cover-letter", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", 405)
			return
		}
		var req struct {
			Company string `json:"company"`
			Role    string `json:"role"`
			Tone    string `json:"tone"`
			Length  string `json:"length"`
		}
		// FIX: check decode error.
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON: "+err.Error(), 400)
			return
		}
		// Generate a basic cover letter from profile data
		name := "Cole Chambers"
		if profile != nil {
			if cand, ok := profile["candidate"].(map[string]interface{}); ok {
				if n, ok := cand["full_name"].(string); ok {
					name = n
				}
			}
		}
		letter := fmt.Sprintf(`Dear Hiring Manager,

I am writing to express my strong interest in the %s position at %s. As an M.S. Chemist, self-taught software developer, and AI/ML practitioner with a $10M account management track record, I bring a rare combination of scientific credibility, technical depth, and client relationship expertise.

My background spans analytical instrumentation (LC-MS, GC-MS, HPLC, NMR), two years of RLHF work at Outlier AI as a Chemistry SME, and hands-on software development in Rust, Python, TypeScript, and Node.js. This T-shaped profile is what makes me uniquely positioned for roles that sit at the intersection of technical knowledge and client-facing work.

I would welcome the opportunity to discuss how my background aligns with your team's needs.

Sincerely,
%s`, req.Role, req.Company, name)
		jsonOK(w, map[string]string{"letter": letter})
	})

	// ── Documents: list / download / delete files in output/ ───────────────────
	// The output/ directory is the index — no separate metadata store. Type is
	// inferred from filename so existing generate-pdf.mjs output shows up too.
	mux.HandleFunc("/api/documents", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		outDir := filepath.Join(rootPath, "output")

		switch r.Method {
		case http.MethodGet:
			type Doc struct {
				Name     string `json:"name"`
				Type     string `json:"type"`
				Size     int64  `json:"size"`
				Modified string `json:"modified"`
			}
			docs := []Doc{}
			entries, _ := os.ReadDir(outDir)
			for _, e := range entries {
				if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
					continue
				}
				info, err := e.Info()
				if err != nil {
					continue
				}
				lower := strings.ToLower(e.Name())
				docType := "document"
				if strings.Contains(lower, "cover") || strings.Contains(lower, "letter") {
					docType = "cover-letter"
				} else if strings.Contains(lower, "cv") || strings.Contains(lower, "resume") {
					docType = "resume"
				}
				docs = append(docs, Doc{
					Name:     e.Name(),
					Type:     docType,
					Size:     info.Size(),
					Modified: info.ModTime().Format("2006-01-02 15:04"),
				})
			}
			jsonOK(w, map[string]interface{}{"documents": docs})

		case http.MethodPost:
			// Save a generated document (e.g. cover letter text) to output/.
			var req struct {
				Name    string `json:"name"`
				Content string `json:"content"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "invalid JSON: "+err.Error(), 400)
				return
			}
			// Sanitize the filename — no path traversal, no separators.
			base := filepath.Base(req.Name)
			if base == "" || base == "." || strings.ContainsAny(base, `/\`) {
				http.Error(w, "invalid filename", 400)
				return
			}
			if err := os.MkdirAll(outDir, 0755); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			if err := os.WriteFile(filepath.Join(outDir, base), []byte(req.Content), 0644); err != nil {
				http.Error(w, "failed to save: "+err.Error(), 500)
				return
			}
			jsonOK(w, map[string]string{"ok": "true", "name": base})

		case http.MethodDelete:
			base := filepath.Base(r.URL.Query().Get("name"))
			if base == "" || base == "." || strings.ContainsAny(base, `/\`) {
				http.Error(w, "invalid filename", 400)
				return
			}
			if err := os.Remove(filepath.Join(outDir, base)); err != nil {
				http.Error(w, "failed to delete: "+err.Error(), 500)
				return
			}
			jsonOK(w, map[string]string{"ok": "true"})

		case http.MethodOptions:
		default:
			http.Error(w, "method not allowed", 405)
		}
	})

	// ── GET /api/documents/download?name=... ───────────────────────────────────
	mux.HandleFunc("/api/documents/download", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		base := filepath.Base(r.URL.Query().Get("name"))
		if base == "" || base == "." || strings.ContainsAny(base, `/\`) {
			http.Error(w, "invalid filename", 400)
			return
		}
		path := filepath.Join(rootPath, "output", base)
		if _, err := os.Stat(path); err != nil {
			http.Error(w, "not found", 404)
			return
		}
		w.Header().Set("Content-Disposition", "attachment; filename=\""+base+"\"")
		http.ServeFile(w, r, path)
	})

	// ── Saved searches ─────────────────────────────────────────────────────────
	savedSearchesPath := filepath.Join(rootPath, "data", "saved-searches.json")

	mux.HandleFunc("/api/saved-searches", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		switch r.Method {
		case http.MethodGet:
			data, err := os.ReadFile(savedSearchesPath)
			if err != nil {
				jsonOK(w, []SavedSearch{})
				return
			}
			var v interface{}
			json.Unmarshal(data, &v)
			jsonOK(w, v)
		case http.MethodPost:
			var s SavedSearch
			if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			s.ID = fmt.Sprintf("%d", time.Now().UnixMilli())
			// Load existing, append, save
			var searches []SavedSearch
			if data, err := os.ReadFile(savedSearchesPath); err == nil {
				json.Unmarshal(data, &searches)
			}
			searches = append(searches, s)
			data, _ := json.MarshalIndent(searches, "", "  ")
			// FIX: check write error.
			if err := os.WriteFile(savedSearchesPath, data, 0644); err != nil {
				http.Error(w, "failed to save search: "+err.Error(), 500)
				return
			}
			jsonOK(w, s)
		case http.MethodOptions:
			// handled by cors()
		default:
			http.Error(w, "method not allowed", 405)
		}
	})

	mux.HandleFunc("/api/saved-searches/", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method != http.MethodDelete {
			http.Error(w, "DELETE only", 405)
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/api/saved-searches/")
		var searches []SavedSearch
		if data, err := os.ReadFile(savedSearchesPath); err == nil {
			json.Unmarshal(data, &searches)
		}
		filtered := searches[:0]
		for _, s := range searches {
			if s.ID != id {
				filtered = append(filtered, s)
			}
		}
		data, _ := json.MarshalIndent(filtered, "", "  ")
		// FIX: check write error.
		if err := os.WriteFile(savedSearchesPath, data, 0644); err != nil {
			http.Error(w, "failed to save searches: "+err.Error(), 500)
			return
		}
		jsonOK(w, map[string]string{"ok": "true"})
	})

	// ── Auto-apply config ──────────────────────────────────────────────────────
	autoApplyCfgPath := filepath.Join(rootPath, "data", "auto-apply-config.json")

	mux.HandleFunc("/api/config/auto-apply", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		switch r.Method {
		case http.MethodGet:
			data, err := os.ReadFile(autoApplyCfgPath)
			if err != nil {
				jsonOK(w, AutoApplyConfig{MinScore: 4.5, MinGDRating: 3.5, MaxPerDay: 5})
				return
			}
			var v interface{}
			json.Unmarshal(data, &v)
			jsonOK(w, v)
		case http.MethodPost:
			var cfg AutoApplyConfig
			if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
				http.Error(w, "invalid JSON: "+err.Error(), 400)
				return
			}
			data, _ := json.MarshalIndent(cfg, "", "  ")
			// FIX: check write error.
			if err := os.WriteFile(autoApplyCfgPath, data, 0644); err != nil {
				http.Error(w, "failed to save config: "+err.Error(), 500)
				return
			}
			jsonOK(w, map[string]string{"ok": "true"})
		case http.MethodOptions:
		default:
			http.Error(w, "method not allowed", 405)
		}
	})

	// ── Pipeline (applications.md) ─────────────────────────────────────────────
	mux.HandleFunc("/api/pipeline", func(w http.ResponseWriter, r *http.Request) {
		type AppEntry struct {
			Company   string `json:"company"`
			Role      string `json:"role"`
			URL       string `json:"url"`
			Status    string `json:"status"`
			AppliedAt string `json:"applied_at"`
			Notes     string `json:"notes"`
		}
		filePath := filepath.Join(rootPath, "data", "applications.md")
		data, err := os.ReadFile(filePath)
		if err != nil {
			jsonOK(w, []AppEntry{})
			return
		}
		// Parse markdown: lines like "- [ ] URL | Company | Role | status | date"
		var entries []AppEntry
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "- [") {
				continue
			}
			// Remove checkbox
			rest := strings.TrimPrefix(strings.TrimPrefix(strings.TrimPrefix(
				line, "- [x] "), "- [X] "), "- [ ] ")
			parts := strings.SplitN(rest, " | ", 5)
			if len(parts) < 3 {
				continue
			}
			e := AppEntry{URL: strings.TrimSpace(parts[0]), Company: strings.TrimSpace(parts[1]), Role: strings.TrimSpace(parts[2])}
			if len(parts) >= 4 {
				e.Status = strings.TrimSpace(parts[3])
			}
			if len(parts) >= 5 {
				e.AppliedAt = strings.TrimSpace(parts[4])
			}
			if e.Status == "" {
				e.Status = "applied"
			}
			entries = append(entries, e)
		}
		jsonOK(w, entries)
	})

	// ── Reload data (in case files changed) ────────────────────────────────────
	mux.HandleFunc("/api/reload", func(w http.ResponseWriter, r *http.Request) {
		pipeline = parsePipelineMD()
		scan = parseScanHistory()
		jsonOK(w, map[string]string{"ok": "true", "pipeline": fmt.Sprintf("%d", len(pipeline)), "scan": fmt.Sprintf("%d", len(scan))})
	})

	// ── Settings (data/settings.json) ─────────────────────────────────────────
	mux.HandleFunc("/api/settings", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		switch r.Method {
		case http.MethodGet:
			settings := loadSettings()
			// Mask the API key value in the response — just report whether it's set
			masked := make(map[string]interface{})
			for k, v := range settings {
				masked[k] = v
			}
			if key, ok := masked["claudeApiKey"].(string); ok && key != "" {
				masked["claudeApiKeySet"] = true
				delete(masked, "claudeApiKey")
			}
			jsonOK(w, masked)
		case http.MethodPost:
			var incoming map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			settings := loadSettings()
			for k, v := range incoming {
				settings[k] = v
			}
			if err := saveSettings(settings); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			jsonOK(w, map[string]string{"ok": "true"})
		case http.MethodOptions:
		default:
			http.Error(w, "method not allowed", 405)
		}
	})

	// ── Tools: run any maintenance/utility script (allowlisted) ───────────────
	// Gives the GUI parity with the CLI — every script is reachable here.
	toolScripts := map[string][]string{
		"doctor":            {"doctor.mjs"},
		"verify-pipeline":   {"verify-pipeline.mjs"},
		"dedup-tracker":     {"dedup-tracker.mjs"},
		"normalize-statuses": {"normalize-statuses.mjs"},
		"merge-tracker":     {"merge-tracker.mjs"},
		"analyze-patterns":  {"analyze-patterns.mjs"},
		"followup-cadence":  {"followup-cadence.mjs"},
		"check-liveness":    {"check-liveness.mjs"},
		"cv-sync-check":     {"cv-sync-check.mjs"},
		"generate-pdf":      {"generate-pdf.mjs"},
		"generate-latex":    {"generate-latex.mjs"},
		"update-check":      {"update-system.mjs", "check"},
		"update-apply":      {"update-system.mjs", "apply"},
		"evaluate-next":     {"evaluate.mjs", "--next"},
	}
	mux.HandleFunc("/api/tools/run", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("script")
		scriptArgs, ok := toolScripts[name]
		if !ok {
			http.Error(w, "unknown or disallowed script", 400)
			return
		}
		cmd := exec.Command("node", scriptArgs...)
		cmd.Dir = rootPath
		sseRun(w, r, cmd)
	})

	// GET /api/tools/list — names the GUI can offer
	mux.HandleFunc("/api/tools/list", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		names := make([]string, 0, len(toolScripts))
		for k := range toolScripts {
			names = append(names, k)
		}
		jsonOK(w, map[string]interface{}{"scripts": names})
	})

	// ── Background daemon: status + toggle ────────────────────────────────────
	mux.HandleFunc("/api/daemon/status", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		settings := loadSettings()
		model, _ := settings["daemonModel"].(string)
		if model == "" {
			model = defaultDaemonModel
		}
		interval := 4.0
		if v, ok := settings["daemonIntervalMin"].(float64); ok && v >= 1 {
			interval = v
		}
		daemonMu.Lock()
		lastRun, lastResult, running := daemonLastRun, daemonLastResult, daemonRunning
		daemonMu.Unlock()
		jsonOK(w, map[string]interface{}{
			"enabled":     daemonIsEnabled(settings),
			"model":       model,
			"intervalMin": interval,
			"running":     running,
			"lastRun":     lastRun,
			"lastResult":  lastResult,
		})
	})

	// POST /api/daemon/toggle {enabled: bool}  — also runs a tick immediately
	// when switched on so the user sees activity without waiting an interval.
	mux.HandleFunc("/api/daemon/toggle", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", 405)
			return
		}
		var req struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON: "+err.Error(), 400)
			return
		}
		settings := loadSettings()
		settings["daemonEnabled"] = req.Enabled
		if err := saveSettings(settings); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if req.Enabled {
			go daemonTick()
		}
		jsonOK(w, map[string]interface{}{"ok": "true", "enabled": req.Enabled})
	})

	// POST /api/daemon/run-now — trigger one tick immediately
	mux.HandleFunc("/api/daemon/run-now", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		go daemonTick()
		jsonOK(w, map[string]string{"ok": "true"})
	})

	// ── Discover: list available models ───────────────────────────────────────
	mux.HandleFunc("/api/discover/models", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		type Model struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Source string `json:"source"`
		}
		type ModelsResp struct {
			Models           []Model `json:"models"`
			OllamaRunning    bool    `json:"ollamaRunning"`
			ClaudeConfigured bool    `json:"claudeConfigured"`
		}

		resp := ModelsResp{}

		// Check Ollama
		// FIX: always close body when err==nil regardless of status code.
		ollamaClient := &http.Client{Timeout: 2 * time.Second}
		ollamaResp, err := ollamaClient.Get("http://localhost:11434/api/tags")
		if err == nil {
			defer ollamaResp.Body.Close()
			if ollamaResp.StatusCode == 200 {
				resp.OllamaRunning = true
				var tags struct {
					Models []struct {
						Name string `json:"name"`
					} `json:"models"`
				}
				json.NewDecoder(ollamaResp.Body).Decode(&tags)
				for _, m := range tags.Models {
					resp.Models = append(resp.Models, Model{ID: m.Name, Name: m.Name, Source: "ollama"})
				}
			}
		}

		// Check Claude API key
		settings := loadSettings()
		if key, ok := settings["claudeApiKey"].(string); ok && key != "" {
			resp.ClaudeConfigured = true
			for _, m := range []string{"claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"} {
				resp.Models = append(resp.Models, Model{ID: m, Name: m, Source: "claude"})
			}
		}

		jsonOK(w, resp)
	})

	// ── Discover: chat with AI (streaming SSE) ────────────────────────────────
	mux.HandleFunc("/api/discover/chat", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", 405)
			return
		}

		var req struct {
			Model          string                   `json:"model"`
			Source         string                   `json:"source"`
			Messages       []map[string]interface{} `json:"messages"`
			IncludeProfile bool                     `json:"includeProfile"`
			IncludeJobs    bool                     `json:"includeJobs"`
			SystemOverride string                   `json:"systemOverride"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}

		sseHeaders(w)
		fl, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", 500)
			return
		}

		// Build system message from profile context (or use override)
		var systemMsg string
		if req.SystemOverride != "" {
			systemMsg = req.SystemOverride
		} else if req.IncludeProfile {
			p := parsePipelineMD()
			s := parseScanHistory()
			jobs := buildJobs(p, s)
			totalJobs := len(jobs)
			appliedJobs := 0
			for _, j := range jobs {
				if j.UserStatus == "applied" || j.UserStatus == "applying" {
					appliedJobs++
				}
			}
			var targetRoles []string
			if profile != nil {
				if tr, ok2 := profile["target_roles"].(map[string]interface{}); ok2 {
					if primary, ok3 := tr["primary"].([]interface{}); ok3 {
						for _, rr := range primary {
							if rs, ok4 := rr.(string); ok4 {
								targetRoles = append(targetRoles, rs)
							}
						}
					}
				}
			}
			systemMsg = buildSystemMessage(profile, cvContent, totalJobs, appliedJobs, targetRoles)

			// Append work preferences if available
			prefPath := filepath.Join(rootPath, "data", "work-preferences.json")
			if prefData, err := os.ReadFile(prefPath); err == nil {
				var prefs map[string]interface{}
				if json.Unmarshal(prefData, &prefs) == nil {
					if summary, ok := prefs["ai_summary"].(string); ok && summary != "" {
						systemMsg += "\n\nWork preferences: " + summary
					}
				}
			}

			// Append work persona if available
			personaPath := filepath.Join(rootPath, "data", "work-persona.json")
			if personaData, err := os.ReadFile(personaPath); err == nil {
				var persona map[string]interface{}
				if json.Unmarshal(personaData, &persona) == nil {
					if name, ok := persona["persona_name"].(string); ok && name != "" {
						personaSummary := "\"" + name + "\""
						if tagline, ok := persona["tagline"].(string); ok && tagline != "" {
							personaSummary += " — " + tagline
						}
						if mbti, ok := persona["mbti_lean"].(string); ok && mbti != "" {
							personaSummary += " MBTI lean: " + mbti + "."
						}
						if mot, ok := persona["motivation_primary"].(string); ok && mot != "" {
							personaSummary += " Primary motivation: " + mot + "."
						}
						if coll, ok := persona["collaboration_style"].(string); ok && coll != "" {
							personaSummary += " Best collaboration: " + coll + "."
						}
						systemMsg += "\n\nWork Persona: " + personaSummary
					}
				}
			}
		}

		switch req.Source {
		case "ollama":
			doStreamOllama(w, r, fl, req.Model, req.Messages, systemMsg)
		case "claude":
			settings := loadSettings()
			apiKey, _ := settings["claudeApiKey"].(string)
			if apiKey == "" {
				fmt.Fprintf(w, "data: %s\n\ndata: __AI_DONE__\n\n",
					jsonToken("Error: Claude API key not configured. Add it in Settings → AI Configuration."))
				fl.Flush()
				return
			}
			doStreamClaude(w, r, fl, req.Model, req.Messages, systemMsg, apiKey)
		default:
			fmt.Fprintf(w, "data: %s\n\ndata: __AI_DONE__\n\n",
				jsonToken("Error: unknown model source '"+req.Source+"'"))
			fl.Flush()
		}
	})

	// ── Portals: update search queries and title filter ───────────────────────
	mux.HandleFunc("/api/portals/update-queries", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", 405)
			return
		}

		var update struct {
			SearchQueries map[string][]string `json:"search_queries"`
			TitlePositive []string            `json:"title_positive"`
			TitleNegative []string            `json:"title_negative"`
		}
		if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}

		portalsPath := filepath.Join(rootPath, "portals.yml")
		raw, err := os.ReadFile(portalsPath)
		if err != nil {
			http.Error(w, "portals.yml not found", 500)
			return
		}

		var portalsMap map[string]interface{}
		if err := yaml.Unmarshal(raw, &portalsMap); err != nil {
			http.Error(w, "failed to parse portals.yml", 500)
			return
		}

		// Update title_filter
		if update.TitlePositive != nil || update.TitleNegative != nil {
			tf := make(map[string]interface{})
			if existing, ok := portalsMap["title_filter"].(map[string]interface{}); ok {
				tf = existing
			}
			if update.TitlePositive != nil {
				tf["positive"] = update.TitlePositive
			}
			if update.TitleNegative != nil {
				tf["negative"] = update.TitleNegative
			}
			portalsMap["title_filter"] = tf
		}

		// Update search_queries
		if update.SearchQueries != nil {
			portalsMap["search_queries"] = update.SearchQueries
		}

		newRaw, err := yaml.Marshal(portalsMap)
		if err != nil {
			http.Error(w, "failed to serialize portals.yml", 500)
			return
		}
		if err := os.WriteFile(portalsPath, newRaw, 0644); err != nil {
			http.Error(w, "failed to write portals.yml", 500)
			return
		}

		// FIX: guard portalsRaw write with mutex.
		portalsRawMu.Lock()
		yaml.Unmarshal(newRaw, &portalsRaw)
		portalsRawMu.Unlock()

		jsonOK(w, map[string]string{"ok": "true"})
	})

	// ── Work Preferences ──────────────────────────────────────────────────────
	mux.HandleFunc("/api/preferences", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		prefsFilePath := filepath.Join(rootPath, guestDataDir(r), "work-preferences.json")
		switch r.Method {
		case http.MethodGet:
			data, err := os.ReadFile(prefsFilePath)
			if err != nil {
				jsonOK(w, map[string]interface{}{})
				return
			}
			var v interface{}
			json.Unmarshal(data, &v)
			jsonOK(w, v)
		case http.MethodPost:
			var incoming map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			if err := os.MkdirAll(filepath.Dir(prefsFilePath), 0755); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			data, _ := json.MarshalIndent(incoming, "", "  ")
			// FIX: check write error.
			if err := os.WriteFile(prefsFilePath, data, 0644); err != nil {
				http.Error(w, "failed to save preferences: "+err.Error(), 500)
				return
			}
			jsonOK(w, map[string]string{"ok": "true"})
		case http.MethodOptions:
		default:
			http.Error(w, "method not allowed", 405)
		}
	})

	// ── Work Persona ───────────────────────────────────────────────────────────
	mux.HandleFunc("/api/work-persona", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		workPersonaFilePath := filepath.Join(rootPath, guestDataDir(r), "work-persona.json")
		switch r.Method {
		case http.MethodGet:
			data, err := os.ReadFile(workPersonaFilePath)
			if err != nil {
				jsonOK(w, nil)
				return
			}
			var v interface{}
			json.Unmarshal(data, &v)
			jsonOK(w, v)
		case http.MethodPost:
			var incoming map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			if err := os.MkdirAll(filepath.Dir(workPersonaFilePath), 0755); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			data, _ := json.MarshalIndent(incoming, "", "  ")
			// FIX: check write error.
			if err := os.WriteFile(workPersonaFilePath, data, 0644); err != nil {
				http.Error(w, "failed to save persona: "+err.Error(), 500)
				return
			}
			jsonOK(w, map[string]string{"ok": "true"})
		case http.MethodOptions:
		default:
			http.Error(w, "method not allowed", 405)
		}
	})

	// ── Guest Mode endpoints ───────────────────────────────────────────────────
	// Guest mode routes all reads/writes to data/guest/ so Cole can experience
	// the full onboarding flow without touching real data.

	guestDataDir := filepath.Join(rootPath, "data", "guest")

	// scaffoldGuestDir creates the minimal empty file layout for guest mode.
	scaffoldGuestDir := func() error {
		if err := os.MkdirAll(guestDataDir, 0755); err != nil {
			return err
		}
		reportsDir := filepath.Join(guestDataDir, "reports")
		if err := os.MkdirAll(reportsDir, 0755); err != nil {
			return err
		}
		// Minimal pipeline.md with empty Pendientes section
		pipelinePath := filepath.Join(guestDataDir, "pipeline.md")
		if _, err := os.Stat(pipelinePath); os.IsNotExist(err) {
			os.WriteFile(pipelinePath, []byte("## Pendientes\n"), 0644)
		}
		// Empty applications.md
		appPath := filepath.Join(guestDataDir, "applications.md")
		if _, err := os.Stat(appPath); os.IsNotExist(err) {
			os.WriteFile(appPath, []byte("## Applications\n"), 0644)
		}
		return nil
	}
	// Ensure guest dir exists at startup.
	scaffoldGuestDir()

	// GET /api/guest/status — returns whether guest mode is active and the data dir.
	mux.HandleFunc("/api/guest/status", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		// The frontend signals guest mode via ?guest=true; the backend always
		// has the directory available — what matters is whether the client is using it.
		jsonOK(w, map[string]interface{}{
			"active":   false, // resolved entirely on the frontend
			"data_dir": guestDataDir,
		})
	})

	// GET /api/guest/reset — wipes data/guest/ and recreates the empty scaffold.
	mux.HandleFunc("/api/guest/reset", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if err := os.RemoveAll(guestDataDir); err != nil {
			http.Error(w, "failed to clear guest data: "+err.Error(), 500)
			return
		}
		if err := scaffoldGuestDir(); err != nil {
			http.Error(w, "failed to scaffold guest dir: "+err.Error(), 500)
			return
		}
		jsonOK(w, map[string]string{"ok": "true"})
	})

	// GET /api/guest/has-persona — lets the frontend know if onboarding is fresh.
	mux.HandleFunc("/api/guest/has-persona", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		personaPath := filepath.Join(guestDataDir, "work-persona.json")
		_, err := os.Stat(personaPath)
		jsonOK(w, map[string]bool{"has_persona": err == nil})
	})

	// ── Redirect guest-mode API calls to guest data directory ─────────────────
	// Any endpoint that reads/writes from data/ will check ?guest=true and
	// reroute to data/guest/ instead.  We handle this by wrapping the mux with
	// a middleware that rewrites rootPath-based paths inside handlers.
	//
	// Rather than rewriting every handler, we expose parallel guest-specific
	// endpoints for the data files used during onboarding:

	// GET /api/guest/preferences
	mux.HandleFunc("/api/guest/preferences", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		path := filepath.Join(guestDataDir, "work-preferences.json")
		switch r.Method {
		case http.MethodGet:
			data, err := os.ReadFile(path)
			if err != nil {
				jsonOK(w, map[string]interface{}{})
				return
			}
			var v interface{}
			json.Unmarshal(data, &v)
			jsonOK(w, v)
		case http.MethodPost:
			var incoming map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			data, _ := json.MarshalIndent(incoming, "", "  ")
			if err := os.WriteFile(path, data, 0644); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			jsonOK(w, map[string]string{"ok": "true"})
		case http.MethodOptions:
		default:
			http.Error(w, "method not allowed", 405)
		}
	})

	// GET /api/guest/work-persona
	mux.HandleFunc("/api/guest/work-persona", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		path := filepath.Join(guestDataDir, "work-persona.json")
		switch r.Method {
		case http.MethodGet:
			data, err := os.ReadFile(path)
			if err != nil {
				jsonOK(w, nil)
				return
			}
			var v interface{}
			json.Unmarshal(data, &v)
			jsonOK(w, v)
		case http.MethodPost:
			var incoming map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			data, _ := json.MarshalIndent(incoming, "", "  ")
			if err := os.WriteFile(path, data, 0644); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			jsonOK(w, map[string]string{"ok": "true"})
		case http.MethodOptions:
		default:
			http.Error(w, "method not allowed", 405)
		}
	})

	// ── Role Presets ──────────────────────────────────────────────────────────

	// GET /api/role-presets
	mux.HandleFunc("/api/role-presets", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		portalsPath := filepath.Join(rootPath, "portals.yml")
		raw, err := os.ReadFile(portalsPath)
		if err != nil {
			jsonOK(w, map[string]interface{}{})
			return
		}
		var portalsMap map[string]interface{}
		if err := yaml.Unmarshal(raw, &portalsMap); err != nil {
			http.Error(w, "failed to parse portals.yml", 500)
			return
		}
		presets, _ := portalsMap["role_presets"]
		if presets == nil {
			presets = map[string]interface{}{}
		}
		jsonOK(w, presets)
	})

	// POST /api/role-presets/apply
	mux.HandleFunc("/api/role-presets/apply", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", 405)
			return
		}
		var req struct {
			Preset string `json:"preset"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		filterPath := filepath.Join(rootPath, "data", ".active-title-filter.json")
		if req.Preset == "" {
			os.Remove(filterPath)
			jsonOK(w, map[string]interface{}{"ok": true, "cleared": true})
			return
		}
		portalsPath := filepath.Join(rootPath, "portals.yml")
		raw, err := os.ReadFile(portalsPath)
		if err != nil {
			http.Error(w, "portals.yml not found", 500)
			return
		}
		var portalsMap map[string]interface{}
		if err := yaml.Unmarshal(raw, &portalsMap); err != nil {
			http.Error(w, "failed to parse portals.yml", 500)
			return
		}
		presetsRaw, _ := portalsMap["role_presets"].(map[string]interface{})
		presetData, ok := presetsRaw[req.Preset]
		if !ok {
			http.Error(w, "preset not found: "+req.Preset, 404)
			return
		}
		data, _ := json.MarshalIndent(presetData, "", "  ")
		os.MkdirAll(filepath.Dir(filterPath), 0755)
		if err := os.WriteFile(filterPath, data, 0644); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		var result interface{}
		json.Unmarshal(data, &result)
		jsonOK(w, result)
	})

	// ── Company Locations (Feature 3) ─────────────────────────────────────────

	// GET /api/companies/locations
	mux.HandleFunc("/api/companies/locations", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		portalsPath := filepath.Join(rootPath, "portals.yml")
		raw, err := os.ReadFile(portalsPath)
		if err != nil {
			jsonOK(w, []CompanyLocation{})
			return
		}
		var portalsMap map[string]interface{}
		if err := yaml.Unmarshal(raw, &portalsMap); err != nil {
			jsonOK(w, []CompanyLocation{})
			return
		}
		companies, _ := portalsMap["tracked_companies"].([]interface{})
		var result []CompanyLocation
		for _, c := range companies {
			cm, ok := c.(map[string]interface{})
			if !ok {
				continue
			}
			lat, hasLat := cm["office_lat"].(float64)
			lng, hasLng := cm["office_lng"].(float64)
			if !hasLat || !hasLng {
				continue
			}
			name, _ := cm["name"].(string)
			city, _ := cm["office_city"].(string)
			addr, _ := cm["office_address"].(string)
			dist := haversine(homeBaseLat, homeBaseLng, lat, lng)
			result = append(result, CompanyLocation{
				Name:       name,
				City:       city,
				Address:    addr,
				Lat:        lat,
				Lng:        lng,
				DistanceMi: math.Round(dist*10) / 10,
			})
		}
		sort.Slice(result, func(i, j int) bool {
			return result[i].DistanceMi < result[j].DistanceMi
		})
		jsonOK(w, result)
	})

	// ── Apply engine + login management endpoints ─────────────────────────────
	registerApplyEndpoints(mux, rootPath)

	// ── Start the background auto-evaluation / enrichment daemon ──────────────
	go runDaemonLoop()

	addr := fmt.Sprintf(":%d", *portFlag)
	url := fmt.Sprintf("http://localhost%s", addr)
	fmt.Printf("\n  Career-Ops Dashboard  →  %s\n\n", url)
	go openBrowser(url)
	log.Fatal(http.ListenAndServe(addr, mux))
}
