package app

import (
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

const moduleImportPrefix = "yukideck/internal/modules/"

// TestNoCrossModuleImports enforces the architectural boundary that sibling
// business modules under internal/modules/* must never import one another,
// and internal/core/* must never import internal/modules/*.
func TestNoCrossModuleImports(t *testing.T) {
	fset := token.NewFileSet()

	t.Run("modules_do_not_import_siblings", func(t *testing.T) {
		modulesRoot := filepath.Join("..", "modules")
		scanned := 0

		err := filepath.WalkDir(modulesRoot, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(d.Name(), ".go") {
				return nil
			}
			rel, err := filepath.Rel(modulesRoot, path)
			if err != nil {
				return err
			}
			parts := strings.Split(filepath.ToSlash(rel), "/")
			if len(parts) < 2 {
				return nil
			}
			ownerMod := parts[0]

			file, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
			if err != nil {
				return err
			}
			scanned++

			for _, imp := range file.Imports {
				impPath := strings.Trim(imp.Path.Value, `"`)
				if !strings.HasPrefix(impPath, moduleImportPrefix) {
					continue
				}
				targetMod, _, _ := strings.Cut(strings.TrimPrefix(impPath, moduleImportPrefix), "/")
				if targetMod != ownerMod {
					t.Errorf("module boundary violation: internal/modules/%s (%s) must not import %s (module %q)",
						rel, ownerMod, impPath, targetMod)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", modulesRoot, err)
		}
		if scanned == 0 {
			t.Fatalf("expected to scan at least one Go file under %s", modulesRoot)
		}
	})

	t.Run("core_does_not_import_modules", func(t *testing.T) {
		coreRoot := filepath.Join("..", "core")
		scanned := 0

		err := filepath.WalkDir(coreRoot, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(d.Name(), ".go") {
				return nil
			}
			file, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
			if err != nil {
				return err
			}
			scanned++

			for _, imp := range file.Imports {
				impPath := strings.Trim(imp.Path.Value, `"`)
				if strings.HasPrefix(impPath, moduleImportPrefix) {
					rel, _ := filepath.Rel(coreRoot, path)
					t.Errorf("layer boundary violation: internal/core/%s must not import %s", filepath.ToSlash(rel), impPath)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", coreRoot, err)
		}
		if scanned == 0 {
			t.Fatalf("expected to scan at least one Go file under %s", coreRoot)
		}
	})
}
