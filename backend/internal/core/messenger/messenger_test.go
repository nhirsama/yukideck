package messenger_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"yukideck/internal/core/crypto"
	"yukideck/internal/core/messenger"
	"yukideck/internal/core/messenger/drivers"
)

type memStore struct {
	mu        sync.Mutex
	nextChID  int64
	nextEpID  int64
	channels  map[int64]messenger.ChannelRecord
	endpoints map[int64]messenger.PushEndpointRecord
}

func newMemStore() *memStore {
	return &memStore{
		channels:  make(map[int64]messenger.ChannelRecord),
		endpoints: make(map[int64]messenger.PushEndpointRecord),
	}
}

func (m *memStore) ListChannels(_ context.Context, userID int64) ([]messenger.ChannelRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []messenger.ChannelRecord
	for _, r := range m.channels {
		if r.UserID == userID {
			out = append(out, r)
		}
	}
	return out, nil
}

func (m *memStore) GetChannel(_ context.Context, userID, id int64) (*messenger.ChannelRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.channels[id]
	if !ok || r.UserID != userID {
		return nil, nil
	}
	return &r, nil
}

func (m *memStore) GetChannelByID(_ context.Context, id int64) (*messenger.ChannelRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.channels[id]
	if !ok {
		return nil, nil
	}
	return &r, nil
}

func (m *memStore) CreateChannel(_ context.Context, rec messenger.ChannelRecord) (*messenger.ChannelRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextChID++
	rec.ID = m.nextChID
	rec.CreatedAt = time.Now()
	rec.UpdatedAt = rec.CreatedAt
	m.channels[rec.ID] = rec
	return &rec, nil
}

func (m *memStore) UpdateChannel(_ context.Context, rec messenger.ChannelRecord) (*messenger.ChannelRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	old, ok := m.channels[rec.ID]
	if !ok || old.UserID != rec.UserID {
		return nil, nil
	}
	rec.CreatedAt = old.CreatedAt
	rec.UpdatedAt = time.Now()
	m.channels[rec.ID] = rec
	return &rec, nil
}

func (m *memStore) DeleteChannel(_ context.Context, userID, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.channels[id]; ok && r.UserID == userID {
		delete(m.channels, id)
	}
	return nil
}

func (m *memStore) ListPushEndpoints(_ context.Context, userID int64) ([]messenger.PushEndpointRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []messenger.PushEndpointRecord
	for _, r := range m.endpoints {
		if r.UserID == userID {
			out = append(out, r)
		}
	}
	return out, nil
}

func (m *memStore) GetPushEndpoint(_ context.Context, userID, id int64) (*messenger.PushEndpointRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.endpoints[id]
	if !ok || r.UserID != userID {
		return nil, nil
	}
	return &r, nil
}

func (m *memStore) GetPushEndpointByTokenHash(_ context.Context, tokenHash string) (*messenger.PushEndpointRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.endpoints {
		if r.TokenHash == tokenHash {
			cp := r
			return &cp, nil
		}
	}
	return nil, nil
}

func (m *memStore) CreatePushEndpoint(_ context.Context, rec messenger.PushEndpointRecord) (*messenger.PushEndpointRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextEpID++
	rec.ID = m.nextEpID
	rec.CreatedAt = time.Now()
	rec.UpdatedAt = rec.CreatedAt
	m.endpoints[rec.ID] = rec
	return &rec, nil
}

func (m *memStore) UpdatePushEndpoint(_ context.Context, rec messenger.PushEndpointRecord) (*messenger.PushEndpointRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	old, ok := m.endpoints[rec.ID]
	if !ok || old.UserID != rec.UserID {
		return nil, nil
	}
	rec.TokenHash = old.TokenHash
	rec.TokenEnc = old.TokenEnc
	rec.CreatedAt = old.CreatedAt
	rec.UpdatedAt = time.Now()
	m.endpoints[rec.ID] = rec
	return &rec, nil
}

func (m *memStore) RotatePushEndpointToken(_ context.Context, userID, id int64, tokenHash, tokenEnc string) (*messenger.PushEndpointRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	old, ok := m.endpoints[id]
	if !ok || old.UserID != userID {
		return nil, nil
	}
	old.TokenHash = tokenHash
	old.TokenEnc = tokenEnc
	m.endpoints[id] = old
	return &old, nil
}

func (m *memStore) TouchPushEndpointCalled(_ context.Context, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.endpoints[id]; ok {
		now := time.Now()
		r.LastCalledAt = &now
		m.endpoints[id] = r
	}
	return nil
}

func (m *memStore) DeletePushEndpoint(_ context.Context, userID, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.endpoints[id]; ok && r.UserID == userID {
		delete(m.endpoints, id)
	}
	return nil
}

type outboundOnlyDriver struct {
	mu   sync.Mutex
	sent []messenger.Message
	fail bool
}

func (d *outboundOnlyDriver) Info() messenger.DriverInfo {
	return messenger.DriverInfo{
		Type:         "bark_stub",
		DisplayName:  "Bark Stub",
		Capabilities: []messenger.Capability{messenger.CapOutbound},
	}
}

func (d *outboundOnlyDriver) ValidateAndMergeConfig(_, in map[string]any) (map[string]any, error) {
	return in, nil
}
func (d *outboundOnlyDriver) MaskConfig(plain map[string]any) map[string]any { return plain }
func (d *outboundOnlyDriver) Send(_ context.Context, _ map[string]any, msg messenger.Message) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.fail {
		return errors.New("simulated outbound failure")
	}
	d.sent = append(d.sent, msg)
	return nil
}
func (d *outboundOnlyDriver) SetupInbound(context.Context, map[string]any, string, string) error {
	return messenger.ErrCapabilityUnsupported
}
func (d *outboundOnlyDriver) TeardownInbound(context.Context, map[string]any) error {
	return messenger.ErrCapabilityUnsupported
}
func (d *outboundOnlyDriver) ParseInbound(context.Context, *http.Request, map[string]any, string) (*messenger.IncomingEvent, error) {
	return nil, messenger.ErrCapabilityUnsupported
}

func TestSymmetricCapabilitiesAndPushURLFanout(t *testing.T) {
	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x55}, 32))
	store := newMemStore()

	var tgMu sync.Mutex
	var tgSent []string
	var registeredSecret string
	tgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		tgMu.Lock()
		defer tgMu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/setWebhook"):
			registeredSecret, _ = body["secret_token"].(string)
		case strings.HasSuffix(r.URL.Path, "/sendMessage"):
			txt, _ := body["text"].(string)
			tgSent = append(tgSent, txt)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": true})
	}))
	defer tgSrv.Close()

	tgDriver := drivers.NewTelegramDriver(5 * time.Second)
	tgDriver.APIBaseURL = tgSrv.URL
	barkDriver := &outboundOnlyDriver{}

	reg := messenger.NewRegistry()
	reg.Register(tgDriver)
	reg.Register(barkDriver)

	bus := messenger.NewCommandBus()
	bus.RegisterCommand(messenger.CommandSpec{
		Command:     "echo",
		Usage:       "/echo <text>",
		Description: "原样回复",
		ModuleID:    "test",
		Handler: func(_ context.Context, ev *messenger.IncomingEvent) (*messenger.Message, error) {
			return &messenger.Message{Content: "ECHO:" + ev.Args}, nil
		},
	})

	svc := messenger.NewService(store, reg, bus, box, "https://deck.example.com", 5*time.Second, nil)
	ctx := context.Background()

	// 1. Outbound-only driver rejects enabling inbound
	_, err := svc.CreateChannel(ctx, 1, messenger.UpsertChannelInput{
		Type:           "bark_stub",
		Name:           "My Bark",
		EnableOutbound: true,
		EnableInbound:  true,
		Enabled:        true,
		Config:         map[string]any{},
	})
	if err == nil {
		t.Fatalf("expected error enabling inbound on outbound-only driver")
	}

	// 2. Create Bark (outbound only) and Telegram (outbound + inbound)
	barkCh, err := svc.CreateChannel(ctx, 1, messenger.UpsertChannelInput{
		Type:           "bark_stub",
		Name:           "My Bark",
		EnableOutbound: true,
		EnableInbound:  false,
		Enabled:        true,
		Config:         map[string]any{},
	})
	if err != nil {
		t.Fatalf("CreateChannel bark: %v", err)
	}

	tgCh, err := svc.CreateChannel(ctx, 1, messenger.UpsertChannelInput{
		Type:              "telegram",
		Name:              "My TG",
		EnableOutbound:    true,
		EnableInbound:     true,
		IsDefaultOutbound: true,
		Enabled:           true,
		Config:            map[string]any{"bot_token": "123456:TESTTOKEN", "chat_id": "999001"},
	})
	if err != nil {
		t.Fatalf("CreateChannel telegram: %v", err)
	}
	if registeredSecret == "" {
		t.Fatalf("expected Telegram setWebhook to register a secret token")
	}

	// 3. Symmetric capability filtering
	outboundList, err := svc.ListChannels(ctx, 1, messenger.CapOutbound)
	if err != nil || len(outboundList) != 2 {
		t.Fatalf("expected 2 outbound channels, got %d (err=%v)", len(outboundList), err)
	}
	inboundList, err := svc.ListChannels(ctx, 1, messenger.CapInbound)
	if err != nil || len(inboundList) != 1 || inboundList[0].ID != tgCh.ID {
		t.Fatalf("expected 1 inbound channel (TG), got %+v (err=%v)", inboundList, err)
	}

	// 4. Normalized PushURL 1-to-N fan-out
	ep, err := svc.CreatePushEndpoint(ctx, 1, messenger.UpsertPushEndpointInput{
		Name:             "Server Alerts",
		TargetMode:       "selected",
		TargetChannelIDs: []int64{barkCh.ID, tgCh.ID},
		Enabled:          true,
	})
	if err != nil {
		t.Fatalf("CreatePushEndpoint: %v", err)
	}
	token := strings.TrimPrefix(ep.PushURL, "https://deck.example.com/api/v1/push/")

	h := messenger.NewHandler(svc, 1<<20, nil)
	r := chi.NewRouter()
	r.Route("/api/v1/push", h.RegisterPublicPushRoutes)
	r.Route("/api/v1/messenger/webhook", h.RegisterPublicWebhookRoutes)

	pushReq := httptest.NewRequest(http.MethodPost, "/api/v1/push/"+token, strings.NewReader(`{"title":"CPU","msg":"95%"}`))
	pushReq.Header.Set("Content-Type", "application/json")
	pushRec := httptest.NewRecorder()
	r.ServeHTTP(pushRec, pushReq)
	if pushRec.Code != http.StatusOK {
		t.Fatalf("PushURL failed: %d %s", pushRec.Code, pushRec.Body.String())
	}
	if len(barkDriver.sent) != 1 || barkDriver.sent[0].Content != "95%" {
		t.Fatalf("expected Bark to receive fanout message, got %+v", barkDriver.sent)
	}
	tgMu.Lock()
	if len(tgSent) != 1 || !strings.Contains(tgSent[0], "CPU") {
		t.Fatalf("expected TG to receive fanout message, got %+v", tgSent)
	}
	tgMu.Unlock()

	// 5. Inbound Telegram Webhook security checks
	badWebhookReq := httptest.NewRequest(http.MethodPost, "/api/v1/messenger/webhook/telegram/2", strings.NewReader(`{"message":{"chat":{"id":999001},"text":"/echo hi"}}`))
	badWebhookReq.Header.Set("X-Telegram-Bot-Api-Secret-Token", "wrong-secret")
	badRec := httptest.NewRecorder()
	r.ServeHTTP(badRec, badWebhookReq)
	if badRec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 on wrong webhook secret, got %d", badRec.Code)
	}

	strangerReq := httptest.NewRequest(http.MethodPost, "/api/v1/messenger/webhook/telegram/2", strings.NewReader(`{"message":{"chat":{"id":777777},"text":"/echo hi"}}`))
	strangerReq.Header.Set("X-Telegram-Bot-Api-Secret-Token", registeredSecret)
	strangerRec := httptest.NewRecorder()
	r.ServeHTTP(strangerRec, strangerReq)
	if strangerRec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 on stranger chat_id, got %d", strangerRec.Code)
	}

	goodReq := httptest.NewRequest(http.MethodPost, "/api/v1/messenger/webhook/telegram/2", strings.NewReader(`{"message":{"chat":{"id":999001},"text":"/echo hello world"}}`))
	goodReq.Header.Set("X-Telegram-Bot-Api-Secret-Token", registeredSecret)
	goodRec := httptest.NewRecorder()
	r.ServeHTTP(goodRec, goodReq)
	if goodRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on valid webhook, got %d %s", goodRec.Code, goodRec.Body.String())
	}

	tgMu.Lock()
	defer tgMu.Unlock()
	if len(tgSent) != 2 || tgSent[1] != "ECHO:hello world" {
		t.Fatalf("expected CommandBus reply via TG, got %+v", tgSent)
	}
}
