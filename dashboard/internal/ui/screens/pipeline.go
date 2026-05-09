package screens

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// PipelineClosedMsg is emitted when the pipeline screen is dismissed.
type PipelineClosedMsg struct{}

// PipelineOpenReportMsg is emitted when a report should be opened in FileViewer.
type PipelineOpenReportMsg struct {
	Path   string
	Title  string
	JobURL string
}

// PipelineOpenURLMsg is emitted when a job URL should be opened in browser.
type PipelineOpenURLMsg struct {
	URL string
}

// PipelineLoadReportMsg requests lazy loading of a report summary.
type PipelineLoadReportMsg struct {
	CareerOpsPath string
	ReportPath    string
}

// PipelineUpdateStatusMsg requests a status update for an application.
type PipelineUpdateStatusMsg struct {
	CareerOpsPath string
	App           model.CareerApplication
	NewStatus     string
}

// PipelineRefreshMsg requests a full tracker reload from disk.
type PipelineRefreshMsg struct{}

// PipelineOpenProgressMsg is emitted when the progress screen should open.
type PipelineOpenProgressMsg struct{}

// PipelineOpenInvestorsMsg is emitted when the investor screen should open.
type PipelineOpenInvestorsMsg struct{}

type reportSummary struct {
	archetype string
	tldr      string
	remote    string
	comp      string
}

// Sort modes
const (
	sortScore   = "score"
	sortDate    = "date"
	sortCompany = "company"
	sortStatus  = "status"
)

// Filter modes
const (
	filterAll       = "all"
	filterEvaluated = "evaluated"
	filterApplied   = "applied"
	filterInterview = "interview"
	filterSkip      = "skip"
	filterRejected  = "rejected"
	filterDiscarded = "discarded"
	filterTop       = "top"
)

type pipelineTab struct {
	filter string
	label  string
}

var pipelineTabs = []pipelineTab{
	{filterAll, "ALL"},
	{filterEvaluated, "EVALUATED"},
	{filterApplied, "APPLIED"},
	{filterInterview, "INTERVIEW"},
	{filterTop, "TOP ≥4"},
	{filterSkip, "SKIP"},
	{filterRejected, "REJECTED"},
	{filterDiscarded, "DISCARDED"},
}

var sortCycle = []string{sortScore, sortDate, sortCompany, sortStatus}

var statusOptions = []string{"Evaluated", "Applied", "Responded", "Interview", "Offer", "Rejected", "Discarded", "SKIP"}

// statusGroupOrder defines display order for grouped view.
var statusGroupOrder = []string{"interview", "offer", "responded", "applied", "evaluated", "skip", "rejected", "discarded"}

// Job type secondary filter constants.
const (
	jobTypeAll    = ""
	jobTypeFAS    = "fas"
	jobTypeTAM    = "tam"
	jobTypeAIML   = "aiml"
	jobTypeSWE    = "swe"
	jobTypeDevRel = "devrel"
	jobTypeGaming = "gaming"
	jobTypeLab    = "lab"
)

var jobTypeCycle = []string{"", "fas", "tam", "aiml", "swe", "devrel", "gaming", "lab"}

var jobTypeLabels = map[string]string{
	"":        "ALL TYPES",
	"fas":     "FAS/AppSci",
	"tam":     "TAM/CSE",
	"aiml":    "AI+ML",
	"swe":     "SWE",
	"devrel":  "DevRel",
	"gaming":  "Gaming",
	"lab":     "Lab/Chem",
}

// PipelineModel implements the career pipeline dashboard screen.
type PipelineModel struct {
	apps          []model.CareerApplication
	filtered      []model.CareerApplication
	metrics       model.PipelineMetrics
	cursor        int
	scrollOffset  int
	sortMode      string
	activeTab     int
	viewMode      string // "grouped" or "flat"
	width, height int
	theme         theme.Theme
	careerOpsPath string
	reportCache   map[string]reportSummary
	// Status picker sub-state
	statusPicker bool
	statusCursor int
	// Job type secondary filter
	jobTypeFilter string
	// Multi-select & bulk actions
	selected   map[int]bool // keyed by app.Number
	bulkPicker bool
	bulkCursor int
}

// NewPipelineModel creates a new pipeline screen.
func NewPipelineModel(t theme.Theme, apps []model.CareerApplication, metrics model.PipelineMetrics, careerOpsPath string, width, height int) PipelineModel {
	m := PipelineModel{
		apps:          apps,
		metrics:       metrics,
		sortMode:      sortScore,
		activeTab:     0,
		viewMode:      "grouped",
		width:         width,
		height:        height,
		theme:         t,
		careerOpsPath: careerOpsPath,
		reportCache:   make(map[string]reportSummary),
		selected:      make(map[int]bool),
	}
	m.applyFilterAndSort()
	return m
}

// Init implements tea.Model.
func (m PipelineModel) Init() tea.Cmd {
	return nil
}

// Resize updates dimensions.
func (m *PipelineModel) Resize(width, height int) {
	m.width = width
	m.height = height
}

// Width returns the current width.
func (m PipelineModel) Width() int { return m.width }

// Height returns the current height.
func (m PipelineModel) Height() int { return m.height }

// CopyReportCache copies the report cache from another pipeline model.
func (m *PipelineModel) CopyReportCache(other *PipelineModel) {
	for k, v := range other.reportCache {
		m.reportCache[k] = v
	}
}

// EnrichReport caches report summary data for preview.
func (m *PipelineModel) EnrichReport(reportPath, archetype, tldr, remote, comp string) {
	m.reportCache[reportPath] = reportSummary{
		archetype: archetype,
		tldr:      tldr,
		remote:    remote,
		comp:      comp,
	}
}

// WithReloadedData rebuilds the pipeline with fresh tracker data while preserving
// the current UI state so manual refresh feels seamless.
func (m PipelineModel) WithReloadedData(apps []model.CareerApplication, metrics model.PipelineMetrics) PipelineModel {
	selectedReportPath := ""
	selectedCompany := ""
	selectedRole := ""
	if app, ok := m.CurrentApp(); ok {
		selectedReportPath = app.ReportPath
		selectedCompany = app.Company
		selectedRole = app.Role
	}

	reloaded := NewPipelineModel(m.theme, apps, metrics, m.careerOpsPath, m.width, m.height)
	reloaded.sortMode = m.sortMode
	reloaded.activeTab = m.activeTab
	reloaded.viewMode = m.viewMode
	reloaded.jobTypeFilter = m.jobTypeFilter
	reloaded.selected = m.selected
	reloaded.applyFilterAndSort()
	reloaded.CopyReportCache(&m)

	for i, app := range reloaded.filtered {
		if selectedReportPath != "" && app.ReportPath == selectedReportPath {
			reloaded.cursor = i
			reloaded.adjustScroll()
			return reloaded
		}
		if selectedReportPath == "" && app.Company == selectedCompany && app.Role == selectedRole {
			reloaded.cursor = i
			reloaded.adjustScroll()
			return reloaded
		}
	}

	if len(reloaded.filtered) == 0 {
		reloaded.cursor = 0
		reloaded.scrollOffset = 0
		return reloaded
	}

	if m.cursor >= len(reloaded.filtered) {
		reloaded.cursor = len(reloaded.filtered) - 1
	} else if m.cursor > 0 {
		reloaded.cursor = m.cursor
	}
	reloaded.adjustScroll()
	return reloaded
}

// CurrentApp returns the currently selected application, if any.
func (m PipelineModel) CurrentApp() (model.CareerApplication, bool) {
	if m.cursor < 0 || m.cursor >= len(m.filtered) {
		return model.CareerApplication{}, false
	}
	return m.filtered[m.cursor], true
}

// Update handles input for the pipeline screen.
func (m PipelineModel) Update(msg tea.Msg) (PipelineModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if m.statusPicker {
			return m.handleStatusPicker(msg)
		}
		return m.handleKey(msg)
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	}
	return m, nil
}

func (m PipelineModel) handleKey(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	// Bulk picker intercepts b key
	if m.bulkPicker {
		return m.handleBulkPicker(msg)
	}

	switch msg.String() {
	case "q", "esc":
		return m, func() tea.Msg { return PipelineClosedMsg{} }

	case "down", "j":
		if len(m.filtered) > 0 {
			m.cursor++
			if m.cursor >= len(m.filtered) {
				m.cursor = len(m.filtered) - 1
			}
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}

	case "up", "k":
		if len(m.filtered) > 0 {
			m.cursor--
			if m.cursor < 0 {
				m.cursor = 0
			}
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}

	case "s":
		// Cycle sort mode
		for i, s := range sortCycle {
			if s == m.sortMode {
				m.sortMode = sortCycle[(i+1)%len(sortCycle)]
				break
			}
		}
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0

	case "f", "right", "l":
		m.activeTab++
		if m.activeTab >= len(pipelineTabs) {
			m.activeTab = 0
		}
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0

	case "left", "h":
		m.activeTab--
		if m.activeTab < 0 {
			m.activeTab = len(pipelineTabs) - 1
		}
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0

	case "v":
		if m.viewMode == "grouped" {
			m.viewMode = "flat"
		} else {
			m.viewMode = "grouped"
		}

	case "enter":
		if app, ok := m.CurrentApp(); ok && app.ReportPath != "" {
			fullPath := filepath.Join(m.careerOpsPath, app.ReportPath)
			title := fmt.Sprintf("%s — %s", app.Company, app.Role)
			jobURL := app.JobURL
			return m, func() tea.Msg {
				return PipelineOpenReportMsg{Path: fullPath, Title: title, JobURL: jobURL}
			}
		}

	case "o":
		if app, ok := m.CurrentApp(); ok && app.JobURL != "" {
			return m, func() tea.Msg {
				return PipelineOpenURLMsg{URL: app.JobURL}
			}
		}

	case "p":
		return m, func() tea.Msg { return PipelineOpenProgressMsg{} }

	case "i":
		return m, func() tea.Msg { return PipelineOpenInvestorsMsg{} }

	case "r":
		return m, func() tea.Msg { return PipelineRefreshMsg{} }

	case "c":
		if len(m.filtered) > 0 {
			m.statusPicker = true
			m.statusCursor = 0
		}

	// Job type secondary filter
	case "t":
		for idx, jt := range jobTypeCycle {
			if jt == m.jobTypeFilter {
				m.jobTypeFilter = jobTypeCycle[(idx+1)%len(jobTypeCycle)]
				break
			}
		}
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0

	// Glassdoor browser lookup
	case "w":
		if app, ok := m.CurrentApp(); ok {
			company := strings.ReplaceAll(app.Company, " ", "-")
			url := "https://www.glassdoor.com/Search/results.htm?keyword=" +
				strings.ReplaceAll(app.Company, " ", "+")
			_ = company // suppress unused var
			return m, func() tea.Msg { return PipelineOpenURLMsg{URL: url} }
		}

	// Checkbox toggle
	case " ":
		if app, ok := m.CurrentApp(); ok {
			if m.selected == nil {
				m.selected = make(map[int]bool)
			}
			m.selected[app.Number] = !m.selected[app.Number]
			// advance cursor
			if m.cursor < len(m.filtered)-1 {
				m.cursor++
				m.adjustScroll()
			}
		}

	// Select all visible / deselect all
	case "a":
		if m.selected == nil {
			m.selected = make(map[int]bool)
		}
		if m.selectedCount() == len(m.filtered) {
			// all selected → deselect all
			m.selected = make(map[int]bool)
		} else {
			for _, app := range m.filtered {
				m.selected[app.Number] = true
			}
		}

	// Bulk status change
	case "b":
		if m.selectedCount() > 0 {
			m.bulkPicker = true
			m.bulkCursor = 0
		} else if len(m.filtered) > 0 {
			// If nothing selected, fall through to single change
			m.statusPicker = true
			m.statusCursor = 0
		}

	case "g":
		if len(m.filtered) > 0 {
			m.cursor = 0
			m.scrollOffset = 0
			return m, m.loadCurrentReport()
		}

	case "G":
		if len(m.filtered) > 0 {
			m.cursor = len(m.filtered) - 1
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}

	case "pgdown", "ctrl+d":
		if len(m.filtered) > 0 {
			halfPage := m.height / 2
			if halfPage < 1 {
				halfPage = 1
			}
			m.cursor += halfPage
			if m.cursor >= len(m.filtered) {
				m.cursor = len(m.filtered) - 1
			}
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}

	case "pgup", "ctrl+u":
		if len(m.filtered) > 0 {
			halfPage := m.height / 2
			if halfPage < 1 {
				halfPage = 1
			}
			m.cursor -= halfPage
			if m.cursor < 0 {
				m.cursor = 0
			}
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}
	}

	return m, nil
}

func (m PipelineModel) handleStatusPicker(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.statusPicker = false
		return m, nil

	case "down", "j":
		m.statusCursor++
		if m.statusCursor >= len(statusOptions) {
			m.statusCursor = len(statusOptions) - 1
		}

	case "up", "k":
		m.statusCursor--
		if m.statusCursor < 0 {
			m.statusCursor = 0
		}

	case "enter":
		m.statusPicker = false
		if app, ok := m.CurrentApp(); ok {
			newStatus := statusOptions[m.statusCursor]
			return m, func() tea.Msg {
				return PipelineUpdateStatusMsg{
					CareerOpsPath: m.careerOpsPath,
					App:           app,
					NewStatus:     newStatus,
				}
			}
		}
	}
	return m, nil
}

func (m PipelineModel) handleBulkPicker(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.bulkPicker = false
	case "down", "j":
		if m.bulkCursor < len(statusOptions)-1 {
			m.bulkCursor++
		}
	case "up", "k":
		if m.bulkCursor > 0 {
			m.bulkCursor--
		}
	case "enter":
		m.bulkPicker = false
		newStatus := statusOptions[m.bulkCursor]
		// Collect all selected apps and update each
		var cmds []tea.Cmd
		path := m.careerOpsPath
		for _, app := range m.filtered {
			if m.selected[app.Number] {
				a := app
				ns := newStatus
				cmds = append(cmds, func() tea.Msg {
					return PipelineUpdateStatusMsg{
						CareerOpsPath: path,
						App:           a,
						NewStatus:     ns,
					}
				})
			}
		}
		m.selected = make(map[int]bool)
		if len(cmds) > 0 {
			return m, cmds[0] // fire first; subsequent refreshes will cascade
		}
	}
	return m, nil
}

// selectedCount returns how many apps in the current filtered list are selected.
func (m PipelineModel) selectedCount() int {
	count := 0
	for _, app := range m.filtered {
		if m.selected[app.Number] {
			count++
		}
	}
	return count
}

func (m PipelineModel) loadCurrentReport() tea.Cmd {
	app, ok := m.CurrentApp()
	if !ok || app.ReportPath == "" {
		return nil
	}
	if _, cached := m.reportCache[app.ReportPath]; cached {
		return nil
	}
	path := m.careerOpsPath
	report := app.ReportPath
	return func() tea.Msg {
		return PipelineLoadReportMsg{CareerOpsPath: path, ReportPath: report}
	}
}

// applyFilterAndSort rebuilds the filtered list from apps.
func (m *PipelineModel) applyFilterAndSort() {
	var filtered []model.CareerApplication

	currentFilter := pipelineTabs[m.activeTab].filter
	for _, app := range m.apps {
		norm := data.NormalizeStatus(app.Status)
		var statusMatch bool
		switch currentFilter {
		case filterAll:
			statusMatch = true
		case filterTop:
			statusMatch = app.Score >= 4.0 && norm != "skip"
		default:
			statusMatch = norm == currentFilter
		}
		if !statusMatch {
			continue
		}
		// Secondary: job type filter
		if m.jobTypeFilter != "" && app.JobType != m.jobTypeFilter {
			continue
		}
		filtered = append(filtered, app)
	}

	// Sort
	switch m.sortMode {
	case sortScore:
		sort.SliceStable(filtered, func(i, j int) bool {
			return filtered[i].Score > filtered[j].Score
		})
	case sortDate:
		sort.SliceStable(filtered, func(i, j int) bool {
			return filtered[i].Date > filtered[j].Date
		})
	case sortCompany:
		sort.SliceStable(filtered, func(i, j int) bool {
			return strings.ToLower(filtered[i].Company) < strings.ToLower(filtered[j].Company)
		})
	case sortStatus:
		sort.SliceStable(filtered, func(i, j int) bool {
			return data.StatusPriority(filtered[i].Status) < data.StatusPriority(filtered[j].Status)
		})
	}

	// In grouped mode, always sort by status priority first, then by selected sort within groups
	if m.viewMode == "grouped" {
		sort.SliceStable(filtered, func(i, j int) bool {
			pi := data.StatusPriority(filtered[i].Status)
			pj := data.StatusPriority(filtered[j].Status)
			if pi != pj {
				return pi < pj
			}
			// Within same group, use selected sort
			switch m.sortMode {
			case sortScore:
				return filtered[i].Score > filtered[j].Score
			case sortDate:
				return filtered[i].Date > filtered[j].Date
			case sortCompany:
				return strings.ToLower(filtered[i].Company) < strings.ToLower(filtered[j].Company)
			default:
				return filtered[i].Score > filtered[j].Score
			}
		})
	}

	m.filtered = filtered
}

// adjustScroll updates scrollOffset so the cursor stays visible.
func (m *PipelineModel) adjustScroll() {
	availHeight := m.height - 12 // header + tabs(2) + metrics + sortbar + footer + preview
	if availHeight < 5 {
		availHeight = 5
	}
	line := m.cursorLineEstimate()
	margin := 3

	if line >= m.scrollOffset+availHeight-margin {
		m.scrollOffset = line - availHeight + margin + 1
	}
	if line < m.scrollOffset+margin {
		m.scrollOffset = line - margin
	}
	if m.scrollOffset < 0 {
		m.scrollOffset = 0
	}
}

func (m PipelineModel) cursorLineEstimate() int {
	if m.viewMode != "grouped" {
		return m.cursor
	}
	// Account for group headers
	line := 0
	prevStatus := ""
	for i, app := range m.filtered {
		norm := data.NormalizeStatus(app.Status)
		if norm != prevStatus {
			line++ // group header
			prevStatus = norm
		}
		if i == m.cursor {
			return line
		}
		line++
	}
	return line
}

// -- View --

// View renders the pipeline screen.
func (m PipelineModel) View() string {
	header := m.renderHeader()
	tabs := m.renderTabs()
	typeBar := m.renderJobTypeBar()
	metricsBar := m.renderMetrics()
	sortBar := m.renderSortBar()
	body := m.renderBody()
	preview := m.renderPreview()
	help := m.renderHelp()

	// Apply scroll to body
	bodyLines := strings.Split(body, "\n")
	if m.scrollOffset > 0 && m.scrollOffset < len(bodyLines) {
		bodyLines = bodyLines[m.scrollOffset:]
	}

	// Calculate available height for body (added 1 for typeBar)
	previewLines := strings.Count(preview, "\n") + 1
	availHeight := m.height - 8 - previewLines
	if availHeight < 3 {
		availHeight = 3
	}
	if len(bodyLines) > availHeight {
		bodyLines = bodyLines[:availHeight]
	}
	body = strings.Join(bodyLines, "\n")

	// Overlays
	if m.statusPicker {
		body = m.overlayStatusPicker(body)
	}
	if m.bulkPicker {
		body = m.overlayBulkPicker(body)
	}

	return lipgloss.JoinVertical(lipgloss.Left,
		header,
		tabs,
		typeBar,
		metricsBar,
		sortBar,
		body,
		preview,
		help,
	)
}

// renderJobTypeBar renders the secondary job-type filter row.
func (m PipelineModel) renderJobTypeBar() string {
	style := lipgloss.NewStyle().Padding(0, 2).Width(m.width)

	var parts []string
	for _, jt := range jobTypeCycle {
		label := jobTypeLabels[jt]
		if jt == m.jobTypeFilter {
			parts = append(parts, lipgloss.NewStyle().
				Foreground(m.theme.Mauve).Bold(true).
				Render("["+label+"]"))
		} else {
			parts = append(parts, lipgloss.NewStyle().
				Foreground(m.theme.Overlay).
				Render(label))
		}
	}

	selNote := ""
	if cnt := m.selectedCount(); cnt > 0 {
		selNote = lipgloss.NewStyle().Foreground(m.theme.Yellow).Bold(true).
			Render(fmt.Sprintf("  ☑ %d selected", cnt))
	}

	return style.Render(strings.Join(parts, "  ") + selNote)
}

// overlayBulkPicker renders the bulk status picker over the body.
func (m PipelineModel) overlayBulkPicker(body string) string {
	pad := lipgloss.NewStyle().Padding(0, 2)
	border := lipgloss.NewStyle().Foreground(m.theme.Yellow).Bold(true)
	cnt := m.selectedCount()
	var picker []string
	picker = append(picker, pad.Render(border.Render(fmt.Sprintf("Bulk change %d selected:", cnt))))
	for i, opt := range statusOptions {
		s := lipgloss.NewStyle().Foreground(m.theme.Text).Width(30)
		prefix := "  "
		if i == m.bulkCursor {
			s = s.Background(m.theme.Overlay).Bold(true)
			prefix = "> "
		}
		picker = append(picker, pad.Render(s.Render(prefix+opt)))
	}
	lines := strings.Split(body, "\n")
	lines = append(lines, picker...)
	return strings.Join(lines, "\n")
}

func (m PipelineModel) renderHeader() string {
	style := lipgloss.NewStyle().
		Bold(true).
		Foreground(m.theme.Text).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 2)

	right := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	avg := fmt.Sprintf("%.1f", m.metrics.AvgScore)
	info := right.Render(fmt.Sprintf("%d offers | Avg %s/5", m.metrics.Total, avg))

	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Render("CAREER PIPELINE")
	gap := m.width - lipgloss.Width(title) - lipgloss.Width(info) - 4
	if gap < 1 {
		gap = 1
	}

	return style.Render(title + strings.Repeat(" ", gap) + info)
}

func (m PipelineModel) renderTabs() string {
	var tabs []string
	var underParts []string

	for i, tab := range pipelineTabs {
		// Count items for this tab
		count := m.countForFilter(tab.filter)
		label := fmt.Sprintf(" %s (%d) ", tab.label, count)

		if i == m.activeTab {
			style := lipgloss.NewStyle().
				Bold(true).
				Foreground(m.theme.Blue).
				Padding(0, 0)
			tabs = append(tabs, style.Render(label))
			underParts = append(underParts, strings.Repeat("━", lipgloss.Width(label)))
		} else {
			style := lipgloss.NewStyle().
				Foreground(m.theme.Subtext).
				Padding(0, 0)
			tabs = append(tabs, style.Render(label))
			underParts = append(underParts, strings.Repeat("─", lipgloss.Width(label)))
		}
	}

	row := lipgloss.JoinHorizontal(lipgloss.Top, tabs...)
	underline := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render(strings.Join(underParts, ""))

	padStyle := lipgloss.NewStyle().Padding(0, 1)
	return padStyle.Render(row) + "\n" + padStyle.Render(underline)
}

func (m PipelineModel) countForFilter(filter string) int {
	count := 0
	for _, app := range m.apps {
		norm := data.NormalizeStatus(app.Status)
		switch filter {
		case filterAll:
			count++
		case filterTop:
			if app.Score >= 4.0 && norm != "skip" {
				count++
			}
		default:
			if norm == filter {
				count++
			}
		}
	}
	return count
}

func (m PipelineModel) renderMetrics() string {
	style := lipgloss.NewStyle().
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 2)

	var parts []string
	statusColors := m.statusColorMap()

	for _, status := range statusGroupOrder {
		count, ok := m.metrics.ByStatus[status]
		if !ok || count == 0 {
			continue
		}
		color := statusColors[status]
		s := lipgloss.NewStyle().Foreground(color)
		parts = append(parts, s.Render(fmt.Sprintf("%s:%d", statusLabel(status), count)))
	}

	return style.Render(strings.Join(parts, "  "))
}

func (m PipelineModel) renderSortBar() string {
	style := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).
		Width(m.width).
		Padding(0, 2)

	sortLabel := fmt.Sprintf("[Sort: %s]", m.sortMode)
	viewLabel := fmt.Sprintf("[View: %s]", m.viewMode)
	count := fmt.Sprintf("%d shown", len(m.filtered))

	return style.Render(fmt.Sprintf("%s  %s  %s", sortLabel, viewLabel, count))
}

func (m PipelineModel) renderBody() string {
	if len(m.filtered) == 0 {
		emptyStyle := lipgloss.NewStyle().
			Foreground(m.theme.Subtext).
			Padding(1, 2)
		return emptyStyle.Render("No offers match this filter")
	}

	var lines []string
	prevStatus := ""
	padStyle := lipgloss.NewStyle().Padding(0, 2)

	for i, app := range m.filtered {
		norm := data.NormalizeStatus(app.Status)

		// Group header in grouped mode
		if m.viewMode == "grouped" && norm != prevStatus {
			count := m.countByNormStatus(norm)
			headerStyle := lipgloss.NewStyle().
				Bold(true).
				Foreground(m.theme.Subtext)
			lines = append(lines, padStyle.Render(
				headerStyle.Render(fmt.Sprintf("── %s (%d) %s",
					strings.ToUpper(statusLabel(norm)), count,
					strings.Repeat("─", max(0, m.width-30-len(statusLabel(norm)))))),
			))
			prevStatus = norm
		}

		selected := i == m.cursor
		line := m.renderAppLine(app, selected)
		lines = append(lines, line)
	}

	return strings.Join(lines, "\n")
}

func (m PipelineModel) renderAppLine(app model.CareerApplication, selected bool) string {
	padStyle := lipgloss.NewStyle().Padding(0, 2)

	// Column widths
	cbW := 2    // checkbox: "☑ " or "☐ "
	numW := 5   // "#123 "
	scoreW := 5 // "4.5  "
	dateW := 10
	companyW := 16
	statusW := 12
	remW := 2  // remote indicator: "R " "H " "O " "? "
	compW := 12
	// Role gets remaining space
	roleW := m.width - cbW - numW - scoreW - dateW - companyW - statusW - remW - compW - 15
	if roleW < 12 {
		roleW = 12
	}

	// Checkbox
	cbChar := "☐"
	cbColor := m.theme.Subtext
	if m.selected[app.Number] {
		cbChar = "☑"
		cbColor = m.theme.Green
	}
	cbStyle := lipgloss.NewStyle().Foreground(cbColor).Width(cbW)
	cb := cbStyle.Render(cbChar)

	// Tracker number (fixed width)
	numText := "#—"
	if app.Number > 0 {
		numText = fmt.Sprintf("#%d", app.Number)
	}
	numStyle := lipgloss.NewStyle().Foreground(m.theme.Blue).Bold(true).Width(numW)

	// Score with color
	scoreStyle := m.scoreStyle(app.Score)
	score := scoreStyle.Render(fmt.Sprintf("%.1f", app.Score))

	// Company (truncate)
	company := truncateRunes(app.Company, companyW)
	companyStyle := lipgloss.NewStyle().Foreground(m.theme.Text).Width(companyW)

	// Date (fixed width)
	dateText := app.Date
	if dateText == "" {
		dateText = "—"
	}
	dateStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(dateW)

	// Role (truncate)
	role := truncateRunes(app.Role, roleW)
	roleStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(roleW)

	// Status with color -- fixed column
	norm := data.NormalizeStatus(app.Status)
	statusColor := m.statusColorMap()[norm]
	statusStyle := lipgloss.NewStyle().Foreground(statusColor).Width(statusW)
	statusText := statusStyle.Render(statusLabel(norm))

	// Remote indicator from report cache
	remChar, remColor := m.remoteIndicator(app.ReportPath)
	remStyle := lipgloss.NewStyle().Foreground(remColor).Width(remW)
	remText := remStyle.Render(remChar)

	// Comp from report cache -- fixed column
	compText := lipgloss.NewStyle().Width(compW).Render("")
	if summary, ok := m.reportCache[app.ReportPath]; ok && summary.comp != "" {
		comp := truncateRunes(summary.comp, compW-1)
		compText = lipgloss.NewStyle().Foreground(m.theme.Yellow).Width(compW).Render(comp)
	}

	line := fmt.Sprintf(" %s %s %s %s %s %s %s %s %s",
		cb,
		numStyle.Render(truncateRunes(numText, numW)),
		score,
		dateStyle.Render(truncateRunes(dateText, dateW)),
		companyStyle.Render(company),
		roleStyle.Render(role),
		statusText,
		remText,
		compText,
	)

	if selected {
		selStyle := lipgloss.NewStyle().
			Background(m.theme.Overlay).
			Width(m.width - 4)
		return padStyle.Render(selStyle.Render(line))
	}
	return padStyle.Render(line)
}

// remoteIndicator returns a single-char indicator and color for the remote field.
func (m PipelineModel) remoteIndicator(reportPath string) (string, lipgloss.Color) {
	summary, ok := m.reportCache[reportPath]
	if !ok || summary.remote == "" {
		return "?", m.theme.Overlay
	}
	r := strings.ToLower(summary.remote)
	switch {
	case strings.Contains(r, "yes") || strings.Contains(r, "fully") || strings.Contains(r, "remote"):
		return "R", m.theme.Green
	case strings.Contains(r, "hybrid") || strings.Contains(r, "partial"):
		return "H", m.theme.Yellow
	case strings.Contains(r, "no") || strings.Contains(r, "office") || strings.Contains(r, "onsite") || strings.Contains(r, "in-person"):
		return "O", m.theme.Red
	default:
		return "?", m.theme.Subtext
	}
}

func (m PipelineModel) renderPreview() string {
	app, ok := m.CurrentApp()
	if !ok {
		return ""
	}

	padStyle := lipgloss.NewStyle().Padding(0, 2)
	divider := lipgloss.NewStyle().Foreground(m.theme.Overlay)

	var lines []string
	lines = append(lines, padStyle.Render(divider.Render(strings.Repeat("─", m.width-4))))

	labelStyle := lipgloss.NewStyle().Foreground(m.theme.Sky).Bold(true)
	valueStyle := lipgloss.NewStyle().Foreground(m.theme.Text)
	dimStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	// Check report cache
	if summary, ok := m.reportCache[app.ReportPath]; ok {
		if summary.archetype != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("Arquetipo: ")+valueStyle.Render(summary.archetype)))
		}
		if summary.tldr != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("TL;DR: ")+valueStyle.Render(summary.tldr)))
		}
		if summary.comp != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("Comp: ")+valueStyle.Render(summary.comp)))
		}
		if summary.remote != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("Remote: ")+valueStyle.Render(summary.remote)))
		}
	} else if app.Notes != "" {
		// Fallback: show notes
		notes := truncateRunes(app.Notes, m.width-10)
		lines = append(lines, padStyle.Render(dimStyle.Render(notes)))
	} else {
		lines = append(lines, padStyle.Render(dimStyle.Render("Loading preview...")))
	}

	return strings.Join(lines, "\n")
}


func (m PipelineModel) renderHelp() string {
	style := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 1)

	keyStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
	descStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	if m.statusPicker || m.bulkPicker {
		return style.Render(
			keyStyle.Render("↑↓/jk") + descStyle.Render(" navigate  ") +
				keyStyle.Render("Enter") + descStyle.Render(" confirm  ") +
				keyStyle.Render("Esc") + descStyle.Render(" cancel"))
	}

	keys := []string{
		keyStyle.Render("↑↓") + descStyle.Render(" nav"),
		keyStyle.Render("enter") + descStyle.Render(" report"),
		keyStyle.Render("c") + descStyle.Render(" status"),
		keyStyle.Render("space") + descStyle.Render(" select"),
		keyStyle.Render("a") + descStyle.Render(" all"),
		keyStyle.Render("b") + descStyle.Render(" bulk"),
		keyStyle.Render("t") + descStyle.Render(" type"),
		keyStyle.Render("tab") + descStyle.Render(" filter"),
		keyStyle.Render("s") + descStyle.Render(" sort"),
		keyStyle.Render("w") + descStyle.Render(" Glassdoor"),
		keyStyle.Render("o") + descStyle.Render(" URL"),
		keyStyle.Render("i") + descStyle.Render(" investors"),
		keyStyle.Render("p") + descStyle.Render(" progress"),
		keyStyle.Render("r") + descStyle.Render(" refresh"),
		keyStyle.Render("q") + descStyle.Render(" quit"),
	}
	return style.Render(strings.Join(keys, descStyle.Render("  ")))
}

// statusColorMap maps canonical status names to display colors.
func (m PipelineModel) statusColorMap() map[string]lipgloss.Color {
	return map[string]lipgloss.Color{
		"applied":   m.theme.Blue,
		"responded": m.theme.Sky,
		"interview": m.theme.Mauve,
		"offer":     m.theme.Green,
		"rejected":  m.theme.Red,
		"discarded": m.theme.Subtext,
		"evaluated": m.theme.Yellow,
		"skip":      m.theme.Subtext,
	}
}

// scoreStyle returns a colored style for a score value.
func (m PipelineModel) scoreStyle(score float64) lipgloss.Style {
	var c lipgloss.Color
	switch {
	case score >= 4.5:
		c = m.theme.Green
	case score >= 4.0:
		c = m.theme.Sky
	case score >= 3.5:
		c = m.theme.Yellow
	case score > 0:
		c = m.theme.Peach
	default:
		c = m.theme.Subtext
	}
	return lipgloss.NewStyle().Foreground(c).Width(5)
}

// statusLabel returns a short display label for a canonical status.
func statusLabel(norm string) string {
	switch norm {
	case "applied":
		return "Applied"
	case "responded":
		return "Responded"
	case "interview":
		return "Interview"
	case "offer":
		return "Offer"
	case "rejected":
		return "Rejected"
	case "discarded":
		return "Discarded"
	case "evaluated":
		return "Evaluated"
	case "skip":
		return "Skip"
	default:
		if norm == "" {
			return "—"
		}
		return norm
	}
}

// truncateRunes truncates s to at most n runes, appending ellipsis if cut.
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	if n <= 1 {
		return string(r[:n])
	}
	return string(r[:n-1]) + "…"
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// overlayStatusPicker renders the single-app status picker as an overlay.
func (m PipelineModel) overlayStatusPicker(body string) string {
	app, ok := m.CurrentApp()
	if !ok {
		return body
	}

	title := fmt.Sprintf("Change status: %s — %s", app.Company, app.Role)
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
	selStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Green)
	optStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	boxStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(m.theme.Blue).
		Padding(1, 3).
		Background(m.theme.Base)

	var rows []string
	rows = append(rows, titleStyle.Render(title))
	rows = append(rows, "")
	for i, opt := range statusOptions {
		if i == m.statusCursor {
			rows = append(rows, selStyle.Render("▶ "+opt))
		} else {
			rows = append(rows, optStyle.Render("  "+opt))
		}
	}
	rows = append(rows, "")
	rows = append(rows, optStyle.Render("↑↓ navigate  Enter confirm  Esc cancel"))

	box := boxStyle.Render(strings.Join(rows, "\n"))
	return lipgloss.Place(m.width, m.height-3, lipgloss.Center, lipgloss.Center, box,
		lipgloss.WithWhitespaceForeground(m.theme.Subtext))
}

// countByNormStatus returns the count of filtered apps with the given normalized status.
func (m PipelineModel) countByNormStatus(norm string) int {
	count := 0
	for _, app := range m.filtered {
		if data.NormalizeStatus(app.Status) == norm {
			count++
		}
	}
	return count
}
