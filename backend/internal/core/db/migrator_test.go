package db

import (
	"testing"
	"testing/fstest"
)

func TestParseMigrationsOrderingAndValidation(t *testing.T) {
	fsys := fstest.MapFS{
		"migrations/002_second.sql": &fstest.MapFile{Data: []byte("SELECT 2;")},
		"migrations/001_first.sql":  &fstest.MapFile{Data: []byte("SELECT 1;")},
		"migrations/README.md":      &fstest.MapFile{Data: []byte("ignore")},
	}

	migs, err := ParseMigrations("demo", fsys)
	if err != nil {
		t.Fatalf("ParseMigrations: %v", err)
	}
	if len(migs) != 2 {
		t.Fatalf("expected 2 migrations, got %d", len(migs))
	}
	if migs[0].Version != 1 || migs[1].Version != 2 {
		t.Fatalf("unexpected ordering: %+v", migs)
	}

	dupFS := fstest.MapFS{
		"001_a.sql": &fstest.MapFile{Data: []byte("SELECT 1;")},
		"001_b.sql": &fstest.MapFile{Data: []byte("SELECT 2;")},
	}
	if _, err := ParseMigrations("dup", dupFS); err == nil {
		t.Fatalf("expected duplicate version error")
	}
}
