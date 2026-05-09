package screens

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"gopkg.in/yaml.v3"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// InvestorsClosedMsg is emitted when the investor screen is dismissed.
type InvestorsClosedMsg struct{}

// InvestorsOpenURLMsg is emitted when an investor website should open.
type InvestorsOpenURLMsg struct{ URL string }

var investorStatusOptions = []string{
	"researching", "pitched", "responded", "meeting", "interested", "passed",
}

// InvestorModel implements the angel investor pitch tracker screen.
type InvestorModel struct {
	investors     []model.Investor
	metrics       model.InvestorMetrics
	cursor        int
	scrollOffset  int
	width, height int
	theme         theme.Theme
	careerOpsPath string
	statusPicker  bool
	statusCursor  int
}

// NewInvestorModel creates the investor screen.
func NewInvestorModel(t theme.Theme, investors []model.Investor, metrics model.InvestorMetrics, careerOpsPath string, width, height int) InvestorModel {
	return InvestorModel{
		investors:     investors,
		metrics:       metrics,
		width:         width,
		height:        height,
		theme:         t,
		careerOpsPath: careerOpsPath,
	}
}

// Init implements tea.Model.
func (m InvestorModel) Init() tea.Cmd { return nil }

// Resize updates dimensions.
func (m *InvestorModel) Resize(w, h int) { m.width = w; m.height = h }

// Update handles input.
func (m InvestorModel) Update(msg tea.Msg) (InvestorModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if m.statusPicker {
			return m.handleStatusPicker(msg)
		}
		return m.handleKey(msg)
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
	}
	return m, nil
}

func (m InvestorModel) handleKey(msg tea.KeyMsg) (InvestorModel, tea.Cmd) {
	switch msg.String() {
	case "q", "esc":
		return m, func() tea.Msg { return InvestorsClosedMsg{} }

	case "down", "j":
		if m.cursor < len(m.investors)-1 {
			m.cursor++
			m.adjustScroll()
		}

	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
			m.adjustScroll()
		}

	case "g":
		m.cursor = 0
		m.scrollOffset = 0

	case "G":
		m.cursor = len(m.investors) - 1
		m.adjustScroll()

	case "o":
		if m.cursor < len(m.investors) {
			iv := m.investors[m.cursor]
			if iv.Website != "" {
				url := iv.Website
				return m, func() tea.Msg { return InvestorsOpenURLMsg{URL: url} }
			}
		}

	case "c":
		if len(m.investors) > 0 {
			m.statusPicker = true
			m.statusCursor = 0
		}

	case "n":
		// Open a Google search for the investor
		if m.cursor < len(m.investors) {
			iv := m.investors[m.cursor]
			query := strings.ReplaceAll(iv.Name+" "+iv.Firm+" angel investor", " ", "+")
			url := "https://www.google.com/search?q=" + query
			return m, func() tea.Msg { return InvestorsOpenURLMsg{URL: url} }
		}
	}
	return m, nil
}

func (m InvestorModel) handleStatusPicker(msg tea.KeyMsg) (InvestorModel, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.statusPicker = false
	case "down", "j":
		if m.statusCursor < len(investorStatusOptions)-1 {
			m.statusCursor++
		}
	case "up", "k":
		if m.statusCursor > 0 {
			m.statusCursor--
		}
	case "enter":
		m.statusPicker = false
		if m.cursor < len(m.investors) {
			newStatus := investorStatusOptions[m.statusCursor]
			m.investors[m.cursor].Status = newStatus
			// Persist to YAML
			_ = m.saveInvestors()
			m.metrics = data.ComputeInvestorMetrics(m.investors)
		}
	}
	return m, nil
}

func (m InvestorModel) saveInvestors() error {
	type entry struct {
		Name    string   `yaml:"name"`
		Firm    string   `yaml:"firm"`
		Focus   []string `yaml:"focus"`
		Website string   `yaml:"website"`
		Contact string   `yaml:"contact"`
		Status  string   `yaml:"status"`
		Notes   string   `yaml:"notes"`
	}
	type doc struct {
		Investors []entry `yaml:"investors"`
	}
	d := doc{}
	for _, iv := range m.investors {
		d.Investors = append(d.Investors, entry{
			Name:    iv.Name,
			Firm:    iv.Firm,
			Focus:   iv.Focus,
			Website: iv.Website,
			Contact: iv.Contact,
			Status:  iv.Status,
			Notes:   iv.Notes,
		})
	}
	raw, err := yaml.Marshal(d)
	if err != nil {
		return err
	}
	outPath := filepath.Join(m.careerOpsPath, "data", "investors.yml")
	return os.WriteFile(outPath, raw, 0644)
}

func (m *InvestorModel) adjustScroll() {
	avail := m.height - 8
	if avail < 3 {
		avail = 3
	}
	margin := 3
	if m.cursor >= m.scrollOffset+avail-margin {
		m.scrollOffset = m.cursor - avail + margin + 1
	}
	if m.cursor < m.scrollOffset+margin {
		m.scrollOffset = m.cursor - margin
	}
	if m.scrollOffset < 0 {
		m.scrollOffset = 0
	}
}

// View renders the investor screen.
func (m InvestorModel) View() string {
	header := m.renderHeader()
	metrics := m.renderMetrics()
	body := m.renderBody()
	preview := m.renderPreview()
	help := m.renderHelp()

	bodyLines := strings.Split(body, "\n")
	if m.scrollOffset > 0 && m.scrollOffset < len(bodyLines) {
		bodyLines = bodyLines[m.scrollOffset:]
	}
	previewH := strings.Count(preview, "\n") + 1
	avail := m.height - 6 - previewH
	if avail < 3 {
		avail = 3
	}
	if len(bodyLines) > avail {
		bodyLines = bodyLines[:avail]
	}
	body = strings.Join(bodyLines, "\n")

	if m.statusPicker {
		body = m.overlayStatusPicker(body)
	}

	return lipgloss.JoinVertical(lipgloss.Left, header, metrics, body, preview, help)
}

func (m InvestorModel) renderHeader() string {
	style := lipgloss.NewStyle().
		Bold(true).Foreground(m.theme.Text).Background(m.theme.Surface).
		Width(m.width).Padding(0, 2)

	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve).Render("🍹 INVESTOR PIPELINE")
	info := lipgloss.NewStyle().Foreground(m.theme.Subtext).
		Render(fmt.Sprintf("%d targets  %d actionable", m.metrics.Total, m.metrics.Actionable))

	gap := m.width - lipgloss.Width(title) - lipgloss.Width(info) - 4
	if gap < 1 {
		gap = 1
	}
	return style.Render(title + strings.Repeat(" ", gap) + info)
}

func (m InvestorModel) renderMetrics() string {
	style := lipgloss.NewStyle().Background(m.theme.Surface).Width(m.width).Padding(0, 2)
	var parts []string
	order := []string{"meeting", "interested", "responded", "pitched", "researching", "passed"}
	colors := map[string]lipgloss.Color{
		"meeting":     m.theme.Green,
		"interested":  m.theme.Green,
		"responded":   m.theme.Blue,
		"pitched":     m.theme.Sky,
		"researching": m.theme.Text,
		"passed":      m.theme.Subtext,
	}
	for _, st := range order {
		if cnt := m.metrics.ByStatus[st]; cnt > 0 {
			c := colors[st]
			parts = append(parts, lipgloss.NewStyle().Foreground(c).Render(
				fmt.Sprintf("%s:%d", strings.Title(st), cnt)))
		}
	}
	return style.Render(strings.Join(parts, "  "))
}

func (m InvestorModel) renderBody() string {
	pad := lipgloss.NewStyle().Padding(0, 2)
	if len(m.investors) == 0 {
		return pad.Render(lipgloss.NewStyle().Foreground(m.theme.Subtext).
			Render("No investors configured — add entries to data/investors.yml"))
	}

	colors := map[string]lipgloss.Color{
		"meeting":     m.theme.Green,
		"interested":  m.theme.Green,
		"responded":   m.theme.Blue,
		"pitched":     m.theme.Sky,
		"researching": m.theme.Text,
		"passed":      m.theme.Subtext,
	}

	nameW := 22
	firmW := 22
	statusW := 14
	focusW := m.width - nameW - firmW - statusW - 14
	if focusW < 10 {
		focusW = 10
	}

	var lines []string
	for i, iv := range m.investors {
		selected := i == m.cursor
		norm := data.NormalizeInvestorStatus(iv.Status)
		color := colors[norm]

		name := truncateRunes(iv.Name, nameW)
		firm := truncateRunes(iv.Firm, firmW)
		focus := truncateRunes(strings.Join(iv.Focus, ", "), focusW)
		statusText := lipgloss.NewStyle().Foreground(color).Width(statusW).
			Render(strings.Title(norm))

		line := fmt.Sprintf(" %-*s  %-*s  %-*s  %s",
			nameW, name, firmW, firm, focusW, focus, statusText)

		if selected {
			sel := lipgloss.NewStyle().Background(m.theme.Overlay).Width(m.width - 4)
			lines = append(lines, pad.Render(sel.Render(line)))
		} else {
			lines = append(lines, pad.Render(line))
		}
	}
	return strings.Join(lines, "\n")
}

func (m InvestorModel) renderPreview() string {
	if m.cursor >= len(m.investors) {
		return ""
	}
	iv := m.investors[m.cursor]
	pad := lipgloss.NewStyle().Padding(0, 2)
	div := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render(strings.Repeat("─", m.width-4))
	label := lipgloss.NewStyle().Foreground(m.theme.Sky).Bold(true)
	value := lipgloss.NewStyle().Foreground(m.theme.Text)
	dim := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	var lines []string
	lines = append(lines, pad.Render(div))
	if iv.Contact != "" {
		lines = append(lines, pad.Render(label.Render("Contact: ")+value.Render(iv.Contact)))
	}
	if iv.Website != "" {
		lines = append(lines, pad.Render(label.Render("Website: ")+dim.Render(iv.Website)))
	}
	if iv.Notes != "" {
		lines = append(lines, pad.Render(label.Render("Notes: ")+value.Render(truncateRunes(iv.Notes, m.width-14))))
	}
	return strings.Join(lines, "\n")
}

func (m InvestorModel) renderHelp() string {
	style := lipgloss.NewStyle().Foreground(m.theme.Subtext).Background(m.theme.Surface).
		Width(m.width).Padding(0, 1)
	key := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
	desc := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	if m.statusPicker {
		return style.Render(key.Render("↑↓/jk") + desc.Render(" navigate  ") +
			key.Render("Enter") + desc.Render(" confirm  ") +
			key.Render("Esc") + desc.Render(" cancel"))
	}

	return style.Render(
		key.Render("↑↓/jk") + desc.Render(" nav  ") +
			key.Render("o") + desc.Render(" website  ") +
			key.Render("n") + desc.Render(" search  ") +
			key.Render("c") + desc.Render(" status  ") +
			key.Render("Esc") + desc.Render(" back to pipeline"))
}

func (m InvestorModel) overlayStatusPicker(body string) string {
	pad := lipgloss.NewStyle().Padding(0, 2)
	border := lipgloss.NewStyle().Foreground(m.theme.Mauve).Bold(true)
	var picker []string
	picker = append(picker, pad.Render(border.Render("Set investor status:")))
	for i, opt := range investorStatusOptions {
		s := lipgloss.NewStyle().Foreground(m.theme.Text).Width(28)
		prefix := "  "
		if i == m.statusCursor {
			s = s.Background(m.theme.Overlay).Bold(true)
			prefix = "> "
		}
		picker = append(picker, pad.Render(s.Render(prefix+strings.Title(opt))))
	}
	lines := strings.Split(body, "\n")
	lines = append(lines, picker...)
	return strings.Join(lines, "\n")
}
