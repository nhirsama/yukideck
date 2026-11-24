package app

import "yukideck/internal/core/module"

// BuildModules is the single registration list for all pluggable business modules.
// Adding a new tool module to YukiDeck only requires implementing module.Module under
// internal/modules/<name> and adding one line below.
func BuildModules(deps module.Deps) []module.Module {
	_ = deps
	return []module.Module{
		// Stage 2: storage.New(deps),
		// Stage 3: assets.New(deps),
		// Stage 4: cronmod.New(deps),
	}
}
