package model

// Investor represents a target angel investor or VC for the beverage pitch.
type Investor struct {
	Name    string
	Firm    string
	Focus   []string // investment themes, e.g. ["beverage","consumer","DTC"]
	Website string
	Contact string
	Status  string // researching | pitched | responded | meeting | passed | interested
	Notes   string
}

// InvestorMetrics holds aggregate stats for the investor screen.
type InvestorMetrics struct {
	Total       int
	ByStatus    map[string]int
	Actionable  int // not passed
}
