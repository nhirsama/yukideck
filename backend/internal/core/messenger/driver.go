package messenger

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"sync"
)

// Capability declares a symmetric direction supported by a channel driver.
type Capability string

const (
	CapOutbound Capability = "outbound" // Can send notifications/messages out
	CapInbound  Capability = "inbound"  // Can receive incoming commands/events
)

var (
	ErrCapabilityUnsupported = errors.New("channel driver does not support this capability")
	ErrUnauthorizedWebhook   = errors.New("unauthorized inbound webhook request")
)

// ConfigField describes a driver configuration field so the frontend can render forms dynamically.
type ConfigField struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Placeholder string `json:"placeholder"`
	Secret      bool   `json:"secret"`
	Required    bool   `json:"required"`
}

// DriverInfo exposes a driver's declared capabilities and config schema.
type DriverInfo struct {
	Type         string        `json:"type"`
	DisplayName  string        `json:"display_name"`
	Description  string        `json:"description"`
	Capabilities []Capability  `json:"capabilities"`
	Fields       []ConfigField `json:"fields"`
}

func (d DriverInfo) Supports(cap Capability) bool {
	for _, c := range d.Capabilities {
		if c == cap {
			return true
		}
	}
	return false
}

// Message is the platform-agnostic outbound payload.
type Message struct {
	Title   string `json:"title,omitempty"`
	Content string `json:"content"`
}

// Attachment represents an inbound media file from an interactive channel.
type Attachment struct {
	Type     string // "image" | "file"
	FileName string
	MimeType string
	Size     int64
	// Download fetches raw bytes with a server-enforced maxBytes guardrail.
	Download func(ctx context.Context, maxBytes int64) ([]byte, error)
}

// IncomingEvent is the normalized, platform-agnostic inbound event produced by any inbound-capable channel.
type IncomingEvent struct {
	UserID      int64
	ChannelID   int64
	ChannelType string
	Text        string
	Command     string // Parsed slash command without leading '/', lowercase (e.g. "help", "cron")
	Args        string
	Attachments []Attachment
}

// Driver is the single unified interface implemented by every channel provider.
// Both outbound and inbound are symmetric capabilities of a channel.
type Driver interface {
	Info() DriverInfo
	ValidateAndMergeConfig(existingPlain, incoming map[string]any) (map[string]any, error)
	MaskConfig(plain map[string]any) map[string]any

	// Outbound capability
	Send(ctx context.Context, cfg map[string]any, msg Message) error

	// Inbound capability
	SetupInbound(ctx context.Context, cfg map[string]any, webhookURL, secret string) error
	TeardownInbound(ctx context.Context, cfg map[string]any) error
	ParseInbound(ctx context.Context, r *http.Request, cfg map[string]any, secret string) (*IncomingEvent, error)
}

// Registry stores all registered channel drivers.
type Registry struct {
	mu      sync.RWMutex
	drivers map[string]Driver
}

func NewRegistry() *Registry {
	return &Registry{drivers: make(map[string]Driver)}
}

func (r *Registry) Register(d Driver) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.drivers[d.Info().Type] = d
}

func (r *Registry) Get(driverType string) (Driver, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	d, ok := r.drivers[driverType]
	return d, ok
}

func (r *Registry) ListInfo() []DriverInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	list := make([]DriverInfo, 0, len(r.drivers))
	for _, d := range r.drivers {
		list = append(list, d.Info())
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].Type < list[j].Type
	})
	return list
}
