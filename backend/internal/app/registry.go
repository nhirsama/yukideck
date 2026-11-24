package app

import (
	"yukideck/internal/core/module"
	"yukideck/internal/modules/storage"
)

// BuildModules is the single registration list for all pluggable business modules.
// Adding a new tool module to YukiDeck only requires implementing module.Module under
// internal/modules/<name> and adding one line below.
func BuildModules(deps module.Deps) []module.Module {
	return []module.Module{
		storage.New(deps),
		// Stage 3: cron / assets ...
	}
}
