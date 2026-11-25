package module

// Meta describes a registered tool module and is exposed via GET /api/v1/meta.
type Meta struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	APIPrefix   string `json:"api_prefix"`
}
