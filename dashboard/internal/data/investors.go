package data

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
	"gopkg.in/yaml.v3"
)

type investorYAML struct {
	Investors []struct {
		Name    string   `yaml:"name"`
		Firm    string   `yaml:"firm"`
		Focus   []string `yaml:"focus"`
		Website string   `yaml:"website"`
		Contact string   `yaml:"contact"`
		Status  string   `yaml:"status"`
		Notes   string   `yaml:"notes"`
	} `yaml:"investors"`
}

// ParseInvestors reads data/investors.yml from careerOpsPath.
func ParseInvestors(careerOpsPath string) []model.Investor {
	path := filepath.Join(careerOpsPath, "data", "investors.yml")
	raw, err := os.ReadFile(path)
	if err != nil {
		// Fallback to root
		path = filepath.Join(careerOpsPath, "investors.yml")
		raw, err = os.ReadFile(path)
		if err != nil {
			return nil
		}
	}

	var cfg investorYAML
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return nil
	}

	out := make([]model.Investor, 0, len(cfg.Investors))
	for _, iv := range cfg.Investors {
		out = append(out, model.Investor{
			Name:    iv.Name,
			Firm:    iv.Firm,
			Focus:   iv.Focus,
			Website: iv.Website,
			Contact: iv.Contact,
			Status:  strings.ToLower(strings.TrimSpace(iv.Status)),
			Notes:   iv.Notes,
		})
	}
	return out
}

// ComputeInvestorMetrics aggregates investor list stats.
func ComputeInvestorMetrics(investors []model.Investor) model.InvestorMetrics {
	m := model.InvestorMetrics{
		Total:    len(investors),
		ByStatus: make(map[string]int),
	}
	for _, iv := range investors {
		m.ByStatus[iv.Status]++
		if iv.Status != "passed" {
			m.Actionable++
		}
	}
	return m
}

// NormalizeInvestorStatus returns a canonical status string.
func NormalizeInvestorStatus(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	switch {
	case s == "interested":
		return "interested"
	case s == "meeting":
		return "meeting"
	case s == "responded":
		return "responded"
	case s == "pitched":
		return "pitched"
	case s == "passed" || s == "declined" || s == "no":
		return "passed"
	default:
		return "researching"
	}
}

// InvestorStatusPriority returns sort priority (lower = higher priority).
func InvestorStatusPriority(status string) int {
	switch NormalizeInvestorStatus(status) {
	case "meeting":
		return 0
	case "interested":
		return 1
	case "responded":
		return 2
	case "pitched":
		return 3
	case "researching":
		return 4
	case "passed":
		return 5
	default:
		return 6
	}
}
