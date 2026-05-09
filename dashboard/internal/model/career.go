package model

// CareerApplication represents a single job application from the tracker.
type CareerApplication struct {
	Number       int
	Date         string
	Company      string
	Role         string
	Status       string
	Score        float64
	ScoreRaw     string
	HasPDF       bool
	ReportPath   string
	ReportNumber string
	Notes        string
	JobURL       string
	JobType      string
	Archetype    string
	TlDr         string
	Remote       string
	CompEstimate string
}

// PipelineMetrics holds aggregate stats for the pipeline dashboard.
type PipelineMetrics struct {
	Total      int
	ByStatus   map[string]int
	AvgScore   float64
	TopScore   float64
	WithPDF    int
	Actionable int
}

// ProgressMetrics holds job search progress analytics.
type ProgressMetrics struct {
	FunnelStages   []FunnelStage
	ScoreBuckets   []ScoreBucket
	WeeklyActivity []WeekActivity
	ResponseRate   float64
	InterviewRate  float64
	OfferRate      float64
	AvgScore       float64
	TopScore       float64
	TotalOffers    int
	ActiveApps     int
}

// FunnelStage represents one stage of the application funnel.
type FunnelStage struct {
	Label string
	Count int
	Pct   float64
}

// ScoreBucket represents a score range and its count.
type ScoreBucket struct {
	Label string
	Count int
}

// WeekActivity represents application activity for a given ISO week.
type WeekActivity struct {
	Week  string
	Count int
}
