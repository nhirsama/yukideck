package scheduler

import (
	"context"
	"testing"
	"time"
)

func TestEngineUpsertAndRemove(t *testing.T) {
	eng := New(5*time.Second, nil)
	eng.Start()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = eng.Stop(ctx)
	}()

	if err := eng.Upsert("demo:1", "0 9 * * *", "Asia/Shanghai", func(ctx context.Context) error {
		return nil
	}); err != nil {
		t.Fatalf("Upsert valid job: %v", err)
	}
	if !eng.Has("demo:1") {
		t.Fatalf("expected job demo:1 to be registered")
	}

	// Replace existing key cleanly
	if err := eng.Upsert("demo:1", "*/5 * * * *", "UTC", func(ctx context.Context) error {
		return nil
	}); err != nil {
		t.Fatalf("Upsert replacement: %v", err)
	}

	// Invalid timezone fails cleanly
	if err := eng.Upsert("demo:bad", "0 9 * * *", "Mars/Phobos", func(ctx context.Context) error {
		return nil
	}); err == nil {
		t.Fatalf("expected error on invalid timezone")
	}

	eng.Remove("demo:1")
	if eng.Has("demo:1") {
		t.Fatalf("expected job demo:1 to be removed")
	}
}
