package clipboard

import "time"

// ClipboardMeta exposes runtime limits and defaults to the frontend.
type ClipboardMeta struct {
	MaxBytes          int64 `json:"max_bytes"`
	DefaultTTLSeconds int64 `json:"default_ttl_seconds"`
	MaxTTLDays        int   `json:"max_ttl_days"`
	SSEInlineMaxBytes int64 `json:"sse_inline_max_bytes"`
}

// ClipboardItem is the external representation of a clipboard text entry.
type ClipboardItem struct {
	ID             int64     `json:"id"`
	Content        string    `json:"content"`
	Preview        string    `json:"preview"`
	ContentOmitted bool      `json:"content_omitted"`
	ByteSize       int       `json:"byte_size"`
	CharCount      int       `json:"char_count"`
	LineCount      int       `json:"line_count"`
	Starred        bool      `json:"starred"`
	SortOrder      int       `json:"sort_order"`
	Version        int64     `json:"version"`
	ExpiresAt      time.Time `json:"expires_at"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type ListItemsResponse struct {
	Items []ClipboardItem `json:"items"`
	Total int             `json:"total"`
}

type ItemResponse struct {
	Item ClipboardItem `json:"item"`
}

type CreateItemInput struct {
	Content   string  `json:"content"`
	ExpiresAt *string `json:"expires_at,omitempty"`
	Starred   *bool   `json:"starred,omitempty"`
	ClientID  string  `json:"client_id,omitempty"`
}

type UpdateItemInput struct {
	Content         string  `json:"content"`
	ExpectedVersion *int64  `json:"expected_version,omitempty"`
	Force           bool    `json:"force,omitempty"`
	ExpiresAt       *string `json:"expires_at,omitempty"`
	Starred         *bool   `json:"starred,omitempty"`
	ClientID        string  `json:"client_id,omitempty"`
}

type PatchItemInput struct {
	Starred   *bool   `json:"starred,omitempty"`
	ExpiresAt *string `json:"expires_at,omitempty"`
	ClientID  string  `json:"client_id,omitempty"`
}

type ReorderItemsInput struct {
	IDs      []int64 `json:"ids"`
	ClientID string  `json:"client_id,omitempty"`
}

type OKResponse struct {
	OK bool `json:"ok"`
}

// ClipboardEvent is broadcast over SSE to active browser tabs of the same user.
type ClipboardEvent struct {
	Type          string         `json:"type" tstype:"'created' | 'updated' | 'deleted' | 'reordered'"`
	ItemID        int64          `json:"item_id,omitempty"`
	ClientID      string         `json:"client_id,omitempty"`
	Version       int64          `json:"version,omitempty"`
	MetaOnly      bool           `json:"meta_only,omitempty"`
	FetchRequired bool           `json:"fetch_required,omitempty"`
	Item          *ClipboardItem `json:"item,omitempty"`
}
