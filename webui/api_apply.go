package main

// api_apply.go — New endpoints for the universal adapter + login management system.
// Registered in main() via registerApplyEndpoints(mux, rootPath).

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Gmail OAuth scopes: read-only inbox access (for verification-code reading
// during portal account creation) plus the user's email address.
const gmailScopes = "https://www.googleapis.com/auth/gmail.readonly " +
	"https://www.googleapis.com/auth/userinfo.email"

// gmailRedirectURI returns the OAuth callback URL. This exact string must be
// registered as an authorized redirect URI in the Google Cloud OAuth client.
func gmailRedirectURI() string {
	port := serverPort
	if port == 0 {
		port = 7410
	}
	return fmt.Sprintf("http://localhost:%d/api/gmail/callback", port)
}

// ── Helpers shared with main.go ───────────────────────────────────────────────
// (jsonOK, cors, sseHeaders already defined in main.go)

// ── registerApplyEndpoints — call from main() ─────────────────────────────────

func registerApplyEndpoints(mux *http.ServeMux, root string) {

	profileJSONPath     := filepath.Join(root, "data", "profile.json")
	learnedFieldsPath   := filepath.Join(root, "data", "learned-fields.json")
	gmailTokenPath      := filepath.Join(root, "data", ".gmail-token.json")

	// ── GET/POST /api/apply/profile — data/profile.json ─────────────────────
	mux.HandleFunc("/api/apply/profile", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		switch r.Method {
		case http.MethodGet:
			data, err := os.ReadFile(profileJSONPath)
			if err != nil {
				// Return scaffold if file doesn't exist yet
				jsonOK(w, map[string]interface{}{
					"firstName": "Cole", "lastName": "Charcham",
					"email": "charcham7@gmail.com", "jobEmail": "",
					"phone": "", "city": "Arlington", "state": "TX",
					"zip": "76010", "address": "", "linkedinUrl": "",
					"githubUrl": "", "portfolioUrl": "", "websiteUrl": "",
					"currentCompany": "", "currentTitle": "", "yearsExperience": "",
					"desiredSalary": "", "availableStartDate": "Immediately",
					"workAuthorized": "Yes", "requireSponsorship": "No",
					"veteranStatus": "I am not a protected veteran",
					"disabilityStatus": "I don't wish to answer", "coverLetter": "",
				})
				return
			}
			var v interface{}
			json.Unmarshal(data, &v)
			jsonOK(w, v)

		case http.MethodPost:
			var incoming map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
				http.Error(w, "invalid JSON: "+err.Error(), 400)
				return
			}
			data, _ := json.MarshalIndent(incoming, "", "  ")
			if err := os.WriteFile(profileJSONPath, data, 0644); err != nil {
				http.Error(w, "failed to write profile.json: "+err.Error(), 500)
				return
			}
			jsonOK(w, map[string]string{"ok": "true"})

		case http.MethodOptions:
		default:
			http.Error(w, "method not allowed", 405)
		}
	})

	// ── GET /api/credentials — list domains (names only) ────────────────────
	mux.HandleFunc("/api/credentials", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}

		// List from Windows Credential Manager
		var domains []string
		out, err := exec.Command("cmd", "/c", "cmdkey /list").Output()
		if err == nil {
			for _, line := range strings.Split(string(out), "\n") {
				if strings.Contains(line, "career-ops:") {
					parts := strings.Split(line, "career-ops:")
					if len(parts) > 1 {
						domain := strings.TrimSpace(parts[1])
						if domain != "" {
							domains = append(domains, domain)
						}
					}
				}
			}
		}

		// Also check encrypted fallback file
		credFile := filepath.Join(root, "data", ".credentials.enc")
		if _, err := os.Stat(credFile); err == nil {
			// File exists — signal that fallback store has entries (don't decrypt here)
			if len(domains) == 0 {
				domains = append(domains, "encrypted-fallback-store")
			}
		}

		if domains == nil {
			domains = []string{}
		}
		jsonOK(w, map[string]interface{}{"domains": domains, "count": len(domains)})
	})

	// ── DELETE /api/credentials/{domain} ────────────────────────────────────
	mux.HandleFunc("/api/credentials/", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodDelete {
			http.Error(w, "DELETE only", 405)
			return
		}
		domain := strings.TrimPrefix(r.URL.Path, "/api/credentials/")
		domain = strings.Trim(domain, "/")
		if domain == "" {
			http.Error(w, "missing domain", 400)
			return
		}
		// Delete from Windows Credential Manager
		exec.Command("cmd", "/c", fmt.Sprintf("cmdkey /delete:career-ops:%s", domain)).Run()
		jsonOK(w, map[string]string{"ok": "true", "domain": domain})
	})

	// ── GET /api/learned-fields — stats on learned-fields.json ──────────────
	mux.HandleFunc("/api/learned-fields", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		data, err := os.ReadFile(learnedFieldsPath)
		if err != nil {
			jsonOK(w, map[string]interface{}{"count": 0, "fields": map[string]interface{}{}})
			return
		}
		var fields map[string]interface{}
		json.Unmarshal(data, &fields)

		// Compute stats
		totalUsed := 0
		for _, v := range fields {
			if fm, ok := v.(map[string]interface{}); ok {
				if tu, ok := fm["timesUsed"].(float64); ok {
					totalUsed += int(tu)
				}
			}
		}
		jsonOK(w, map[string]interface{}{
			"count":     len(fields),
			"totalUsed": totalUsed,
			"fields":    fields,
		})
	})

	// ── DELETE /api/learned-fields/{label} ──────────────────────────────────
	mux.HandleFunc("/api/learned-fields/", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodDelete {
			http.Error(w, "DELETE only", 405)
			return
		}
		label := strings.TrimPrefix(r.URL.Path, "/api/learned-fields/")
		label = strings.Trim(label, "/")
		if label == "" {
			http.Error(w, "missing label", 400)
			return
		}
		data, err := os.ReadFile(learnedFieldsPath)
		if err != nil {
			jsonOK(w, map[string]string{"ok": "true"})
			return
		}
		var fields map[string]interface{}
		json.Unmarshal(data, &fields)
		delete(fields, label)
		out, _ := json.MarshalIndent(fields, "", "  ")
		os.WriteFile(learnedFieldsPath, out, 0644)
		jsonOK(w, map[string]string{"ok": "true", "deleted": label})
	})

	// ── GET /api/gmail/status ────────────────────────────────────────────────
	mux.HandleFunc("/api/gmail/status", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		data, err := os.ReadFile(gmailTokenPath)
		if err != nil {
			jsonOK(w, map[string]interface{}{"connected": false, "email": ""})
			return
		}
		var token map[string]interface{}
		json.Unmarshal(data, &token)
		connected := token["access_token"] != nil || token["refresh_token"] != nil
		email, _ := token["email"].(string)
		jsonOK(w, map[string]interface{}{"connected": connected, "email": email})
	})

	// ── POST /api/gmail/setup — start the OAuth consent flow ────────────────
	mux.HandleFunc("/api/gmail/setup", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", 405)
			return
		}

		settings := loadSettings()
		clientID, _ := settings["gmailClientId"].(string)
		clientSecret, _ := settings["gmailClientSecret"].(string)
		if clientID == "" || clientSecret == "" {
			jsonOK(w, map[string]interface{}{
				"status": "needs-credentials",
				"message": "Gmail needs a Google OAuth client. In Google Cloud Console: " +
					"create an OAuth client (type: Web application), add the redirect URI " +
					gmailRedirectURI() + " , then paste the Client ID and Client Secret " +
					"into Settings and try again.",
				"redirectUri": gmailRedirectURI(),
				"authUrl":     "",
			})
			return
		}

		authURL := "https://accounts.google.com/o/oauth2/v2/auth?" + url.Values{
			"client_id":     {clientID},
			"redirect_uri":  {gmailRedirectURI()},
			"response_type": {"code"},
			"scope":         {gmailScopes},
			"access_type":   {"offline"}, // request a refresh token
			"prompt":        {"consent"},
		}.Encode()

		// Open the consent page in the user's default browser.
		openBrowser(authURL)

		jsonOK(w, map[string]interface{}{
			"status": "opened",
			"message": "Google consent page opened in your browser. Approve access — " +
				"this tab will confirm when the connection completes.",
			"authUrl": authURL,
		})
	})

	// ── GET /api/gmail/callback — OAuth redirect target ─────────────────────
	// Google redirects here with ?code=... after the user approves. We exchange
	// the code for tokens, fetch the account email, and persist to disk.
	mux.HandleFunc("/api/gmail/callback", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")

		writePage := func(title, body string) {
			fmt.Fprintf(w, `<!doctype html><html><body style="font-family:system-ui;background:#0d0f12;`+
				`color:#e2e8f0;padding:48px;text-align:center"><h2>%s</h2><p>%s</p>`+
				`<p style="color:#64748b">You can close this tab and return to career-ops.</p>`+
				`</body></html>`, title, body)
		}

		if errParam := r.URL.Query().Get("error"); errParam != "" {
			writePage("❌ Gmail connection cancelled", "Google returned: "+errParam)
			return
		}
		code := r.URL.Query().Get("code")
		if code == "" {
			writePage("❌ Gmail connection failed", "No authorization code was returned.")
			return
		}

		settings := loadSettings()
		clientID, _ := settings["gmailClientId"].(string)
		clientSecret, _ := settings["gmailClientSecret"].(string)
		if clientID == "" || clientSecret == "" {
			writePage("❌ Gmail connection failed", "OAuth client credentials are missing from Settings.")
			return
		}

		// ── Exchange the authorization code for tokens ──────────────────────
		client := &http.Client{Timeout: 20 * time.Second}
		tokenResp, err := client.PostForm("https://oauth2.googleapis.com/token", url.Values{
			"code":          {code},
			"client_id":     {clientID},
			"client_secret": {clientSecret},
			"redirect_uri":  {gmailRedirectURI()},
			"grant_type":    {"authorization_code"},
		})
		if err != nil {
			writePage("❌ Gmail connection failed", "Token exchange error: "+err.Error())
			return
		}
		defer tokenResp.Body.Close()
		tokenBody, _ := io.ReadAll(tokenResp.Body)
		if tokenResp.StatusCode != 200 {
			writePage("❌ Gmail connection failed", "Google rejected the token request: "+string(tokenBody))
			return
		}

		var tok struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			ExpiresIn    int    `json:"expires_in"`
			TokenType    string `json:"token_type"`
		}
		if err := json.Unmarshal(tokenBody, &tok); err != nil || tok.AccessToken == "" {
			writePage("❌ Gmail connection failed", "Could not parse the token response.")
			return
		}

		// ── Fetch the connected account's email address ─────────────────────
		email := ""
		userReq, _ := http.NewRequest("GET", "https://www.googleapis.com/oauth2/v2/userinfo", nil)
		userReq.Header.Set("Authorization", "Bearer "+tok.AccessToken)
		if userResp, err := client.Do(userReq); err == nil {
			defer userResp.Body.Close()
			var info struct {
				Email string `json:"email"`
			}
			json.NewDecoder(userResp.Body).Decode(&info)
			email = info.Email
		}

		// ── Persist the token ───────────────────────────────────────────────
		stored := map[string]interface{}{
			"access_token":  tok.AccessToken,
			"refresh_token": tok.RefreshToken,
			"email":         email,
			"token_type":    tok.TokenType,
			"obtained_at":   time.Now().Unix(),
			"expires_at":    time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second).Unix(),
		}
		out, _ := json.MarshalIndent(stored, "", "  ")
		if err := os.WriteFile(gmailTokenPath, out, 0600); err != nil {
			writePage("❌ Gmail connection failed", "Could not save the token: "+err.Error())
			return
		}

		label := email
		if label == "" {
			label = "your account"
		}
		writePage("✅ Gmail connected", "Connected as <strong>"+label+"</strong>.")
	})

	// ── POST /api/vision/analyze-form — Claude Vision field mapper ───────────
	mux.HandleFunc("/api/vision/analyze-form", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", 405)
			return
		}

		var req struct {
			Screenshot string `json:"screenshot"` // base64 PNG
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Screenshot == "" {
			http.Error(w, "missing screenshot", 400)
			return
		}

		// Load Claude API key from settings
		settings := loadSettings()
		apiKey, _ := settings["claudeApiKey"].(string)
		if apiKey == "" {
			// No API key — return empty mappings (universal adapter falls through to Layer 4)
			jsonOK(w, map[string]interface{}{"mappings": []interface{}{}})
			return
		}

		// Call Claude vision API
		profile, err := os.ReadFile(profileJSONPath)
		if err != nil {
			profile = []byte("{}")
		}

		visionPrompt := `You are analyzing a job application form screenshot. 
Extract ALL visible form field labels and map them to the appropriate values from this applicant profile: ` +
			string(profile) + `

Return ONLY a JSON array of {label, value} objects for fields you can confidently fill.
Example: [{"label": "First Name", "value": "Cole"}, {"label": "Phone", "value": "555-1234"}]
For fields you cannot determine a value for, omit them entirely.
Return ONLY valid JSON, no markdown.`

		type ClaudeContent struct {
			Type   string                 `json:"type"`
			Source map[string]interface{} `json:"source,omitempty"`
			Text   string                 `json:"text,omitempty"`
		}
		type ClaudeMsg struct {
			Role    string          `json:"role"`
			Content []ClaudeContent `json:"content"`
		}
		reqBody := map[string]interface{}{
			"model":      "claude-haiku-4-5-20251001",
			"max_tokens": 1024,
			"messages": []ClaudeMsg{
				{
					Role: "user",
					Content: []ClaudeContent{
						{
							Type: "image",
							Source: map[string]interface{}{
								"type":       "base64",
								"media_type": "image/png",
								"data":       req.Screenshot,
							},
						},
						{Type: "text", Text: visionPrompt},
					},
				},
			},
		}

		reqBytes, _ := json.Marshal(reqBody)
		claudeReq, _ := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", strings.NewReader(string(reqBytes)))
		claudeReq.Header.Set("Content-Type", "application/json")
		claudeReq.Header.Set("x-api-key", apiKey)
		claudeReq.Header.Set("anthropic-version", "2023-06-01")

		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Do(claudeReq)
		if err != nil {
			jsonOK(w, map[string]interface{}{"mappings": []interface{}{}, "error": err.Error()})
			return
		}
		defer resp.Body.Close()

		var claudeResp struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		}
		json.NewDecoder(resp.Body).Decode(&claudeResp)

		// Parse the JSON array from Claude's response
		var mappings []interface{}
		for _, c := range claudeResp.Content {
			if c.Type == "text" {
				text := strings.TrimSpace(c.Text)
				// Strip markdown code fences if present
				text = strings.TrimPrefix(text, "```json")
				text = strings.TrimPrefix(text, "```")
				text = strings.TrimSuffix(text, "```")
				text = strings.TrimSpace(text)
				if err := json.Unmarshal([]byte(text), &mappings); err == nil {
					break
				}
			}
		}
		if mappings == nil {
			mappings = []interface{}{}
		}

		jsonOK(w, map[string]interface{}{"mappings": mappings})
	})
}
