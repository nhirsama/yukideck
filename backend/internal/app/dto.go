package app

import "yukideck/internal/core/module"

type HealthResponse struct {
	Status  string `json:"status"`
	Version string `json:"version"`
}

type AppMeta struct {
	App       string        `json:"app"`
	Version   string        `json:"version"`
	UIEnabled bool          `json:"ui_enabled"`
	Modules   []module.Meta `json:"modules"`
}
