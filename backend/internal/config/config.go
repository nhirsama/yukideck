package config

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/caarlos0/env/v11"
)

// Config holds all runtime settings loaded from environment variables.
type Config struct {
	HTTPAddr           string   `env:"HTTP_ADDR" envDefault:":8080"`
	PublicBaseURL      string   `env:"PUBLIC_BASE_URL" envDefault:"http://localhost:8080"`
	UIEnabled          bool     `env:"UI_ENABLED" envDefault:"true"`
	FrontendBaseURL    string   `env:"FRONTEND_BASE_URL" envDefault:"/"`
	CORSAllowedOrigins []string `env:"CORS_ALLOWED_ORIGINS" envSeparator:","`

	CookieDomain   string `env:"COOKIE_DOMAIN"`
	CookieSecure   bool   `env:"COOKIE_SECURE" envDefault:"false"`
	CookieSameSite string `env:"COOKIE_SAMESITE" envDefault:"lax"`

	DatabaseURL  string `env:"DATABASE_URL,required"`
	AppSecretKey string `env:"APP_SECRET_KEY,required"`

	OIDCIssuer       string   `env:"OIDC_ISSUER,required"`
	OIDCClientID     string   `env:"OIDC_CLIENT_ID,required"`
	OIDCClientSecret string   `env:"OIDC_CLIENT_SECRET,required"`
	OIDCRedirectURL  string   `env:"OIDC_REDIRECT_URL,required"`
	OIDCScopes       []string `env:"OIDC_SCOPES" envDefault:"openid,profile,email" envSeparator:","`

	DisabledModules []string `env:"DISABLED_MODULES" envSeparator:","`
	LogLevel        string   `env:"LOG_LEVEL" envDefault:"info"`
	LogFormat       string   `env:"LOG_FORMAT" envDefault:"text"`

	// Server protection guardrails (applied only to paths touching server resources).
	RequestMaxBodyBytes int64         `env:"REQUEST_MAX_BODY_BYTES" envDefault:"1048576"`
	ExternalHTTPTimeout time.Duration `env:"EXTERNAL_HTTP_TIMEOUT" envDefault:"10s"`
	StorageProxyMaxMB   int64         `env:"STORAGE_PROXY_MAX_MB" envDefault:"20"`
	ClipboardMaxBytes   int64         `env:"CLIPBOARD_MAX_BYTES" envDefault:"262144"`
}

func Load() (*Config, error) {
	cfg := &Config{}
	if err := env.Parse(cfg); err != nil {
		return nil, fmt.Errorf("parse env config: %w", err)
	}
	cfg.PublicBaseURL = strings.TrimRight(strings.TrimSpace(cfg.PublicBaseURL), "/")
	cfg.FrontendBaseURL = strings.TrimSpace(cfg.FrontendBaseURL)
	if cfg.FrontendBaseURL == "" {
		cfg.FrontendBaseURL = "/"
	}
	if _, err := cfg.MasterKeyBytes(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// MasterKeyBytes decodes APP_SECRET_KEY (64-char hex or base64 encoding 32 bytes).
func (c *Config) MasterKeyBytes() ([]byte, error) {
	raw := strings.TrimSpace(c.AppSecretKey)
	if len(raw) == 64 {
		if b, err := hex.DecodeString(raw); err == nil && len(b) == 32 {
			return b, nil
		}
	}
	if b, err := base64.StdEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if b, err := base64.RawURLEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	return nil, fmt.Errorf("APP_SECRET_KEY must decode to exactly 32 bytes (64-char hex or base64)")
}

func (c *Config) SameSiteMode() http.SameSite {
	switch strings.ToLower(strings.TrimSpace(c.CookieSameSite)) {
	case "strict":
		return http.SameSiteStrictMode
	case "none":
		return http.SameSiteNoneMode
	default:
		return http.SameSiteLaxMode
	}
}

func (c *Config) IsModuleDisabled(id string) bool {
	target := strings.ToLower(strings.TrimSpace(id))
	for _, disabled := range c.DisabledModules {
		if strings.ToLower(strings.TrimSpace(disabled)) == target {
			return true
		}
	}
	return false
}
