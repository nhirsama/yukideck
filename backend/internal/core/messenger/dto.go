package messenger

import "time"

// Capability declares a symmetric direction supported by a channel driver.
type Capability string

const (
	CapOutbound Capability = "outbound" // Can send notifications/messages out
	CapInbound  Capability = "inbound"  // Can receive incoming commands/events
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
	Capabilities []Capability  `json:"capabilities" tstype:"('outbound' | 'inbound')[]"`
	Fields       []ConfigField `json:"fields"`
}

// Message is the platform-agnostic outbound payload.
type Message struct {
	Title   string `json:"title,omitempty"`
	Content string `json:"content"`
}

type DeliveryResult struct {
	ChannelID   int64  `json:"channel_id"`
	ChannelName string `json:"channel_name"`
	ChannelType string `json:"channel_type"`
	OK          bool   `json:"ok"`
	Error       string `json:"error,omitempty"`
}

type ChannelView struct {
	ID                int64          `json:"id"`
	Type              string         `json:"type"`
	Name              string         `json:"name"`
	Capabilities      []Capability   `json:"capabilities" tstype:"('outbound' | 'inbound')[]"`
	EnableOutbound    bool           `json:"enable_outbound"`
	EnableInbound     bool           `json:"enable_inbound"`
	IsDefaultOutbound bool           `json:"is_default_outbound"`
	Enabled           bool           `json:"enabled"`
	Config            map[string]any `json:"config" tstype:"{ [key: string]: unknown }"`
	WebhookURL        string         `json:"webhook_url,omitempty"`
	WebhookWarning    string         `json:"webhook_warning,omitempty"`
	CreatedAt         time.Time      `json:"created_at"`
	UpdatedAt         time.Time      `json:"updated_at"`
}

type PushEndpointView struct {
	ID               int64      `json:"id"`
	Name             string     `json:"name"`
	PushURL          string     `json:"push_url"`
	TargetMode       string     `json:"target_mode" tstype:"'default' | 'selected'"`
	TargetChannelIDs []int64    `json:"target_channel_ids"`
	Enabled          bool       `json:"enabled"`
	LastCalledAt     *time.Time `json:"last_called_at,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

type UpsertChannelInput struct {
	Type              string         `json:"type"`
	Name              string         `json:"name"`
	EnableOutbound    bool           `json:"enable_outbound"`
	EnableInbound     bool           `json:"enable_inbound"`
	IsDefaultOutbound bool           `json:"is_default_outbound"`
	Enabled           bool           `json:"enabled"`
	Config            map[string]any `json:"config" tstype:"{ [key: string]: unknown }"`
}

type UpsertPushEndpointInput struct {
	Name             string  `json:"name"`
	TargetMode       string  `json:"target_mode" tstype:"'default' | 'selected'"`
	TargetChannelIDs []int64 `json:"target_channel_ids"`
	Enabled          bool    `json:"enabled"`
}
