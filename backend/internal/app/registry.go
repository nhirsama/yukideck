package app

import (
	"yukideck/internal/core/module"
	"yukideck/internal/modules/ai_usage"
	"yukideck/internal/modules/assets"
	"yukideck/internal/modules/clipboard"
	"yukideck/internal/modules/planner"
	"yukideck/internal/modules/storage"
)

// BuildModules is the single registration list for all pluggable business modules.
// Adding a new tool module to YukiDeck only requires implementing module.Module under
// internal/modules/<name> and adding one line below.
func BuildModules(deps module.Deps) []module.Module {
	return []module.Module{
		storage.New(deps),
		planner.New(deps),
		ai_usage.New(deps),
		assets.New(deps),
		clipboard.New(deps),
	}
}
