package storage

import (
	"bytes"
	"context"
	"encoding/binary"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"yukideck/internal/core/auth"
	"yukideck/internal/core/crypto"
	"yukideck/internal/core/messenger"
)

// --- In-memory ConfigStore & Bucket for isolated unit tests ---

type memConfigStore struct {
	mu   sync.Mutex
	cfgs map[int64]ConfigRecord
	dims map[int64]map[string]ObjectDimRecord
}

func (m *memConfigStore) GetConfig(_ context.Context, userID int64) (*ConfigRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.cfgs[userID]
	if !ok {
		return nil, nil
	}
	return &r, nil
}

func (m *memConfigStore) UpsertConfig(_ context.Context, rec ConfigRecord) (*ConfigRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec.UpdatedAt = time.Now()
	m.cfgs[rec.UserID] = rec
	return &rec, nil
}

func (m *memConfigStore) ListObjectDims(_ context.Context, userID int64) (map[string]ObjectDimRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]ObjectDimRecord)
	for k, v := range m.dims[userID] {
		out[k] = v
	}
	return out, nil
}

func (m *memConfigStore) UpsertObjectDims(_ context.Context, userID int64, items []ObjectDimRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.dims == nil {
		m.dims = make(map[int64]map[string]ObjectDimRecord)
	}
	if m.dims[userID] == nil {
		m.dims[userID] = make(map[string]ObjectDimRecord)
	}
	for _, it := range items {
		m.dims[userID][it.Key] = it
	}
	return nil
}

func (m *memConfigStore) RenameObjectDimKey(_ context.Context, userID int64, oldKey, newKey string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.dims == nil || m.dims[userID] == nil {
		return nil
	}
	if v, ok := m.dims[userID][oldKey]; ok {
		delete(m.dims[userID], oldKey)
		v.Key = newKey
		m.dims[userID][newKey] = v
	}
	return nil
}

func (m *memConfigStore) DeleteObjectDimsByKeys(_ context.Context, userID int64, keys []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.dims == nil || m.dims[userID] == nil {
		return nil
	}
	for _, k := range keys {
		delete(m.dims[userID], k)
	}
	return nil
}

func (m *memConfigStore) DeleteAllObjectDims(_ context.Context, userID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.dims != nil {
		delete(m.dims, userID)
	}
	return nil
}

type memBucket struct {
	mu   sync.Mutex
	objs map[string]struct {
		data        []byte
		contentType string
		meta        map[string]string
		modified    time.Time
	}
}

func newMemBucket() *memBucket {
	return &memBucket{
		objs: make(map[string]struct {
			data        []byte
			contentType string
			meta        map[string]string
			modified    time.Time
		}),
	}
}

func (b *memBucket) TestConnection(context.Context) error { return nil }

func (b *memBucket) List(_ context.Context, prefix, delimiter, _ string, _ int32) (*S3ListResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	keys := make([]string, 0, len(b.objs))
	for k := range b.objs {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	res := &S3ListResult{}
	prefixSet := map[string]struct{}{}
	for _, k := range keys {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		rest := strings.TrimPrefix(k, prefix)
		if delimiter != "" && strings.Contains(rest, delimiter) {
			idx := strings.Index(rest, delimiter)
			dp := prefix + rest[:idx+len(delimiter)]
			if _, seen := prefixSet[dp]; !seen {
				prefixSet[dp] = struct{}{}
				res.CommonPrefixes = append(res.CommonPrefixes, dp)
			}
			continue
		}
		item := b.objs[k]
		res.Objects = append(res.Objects, S3Object{
			Key:          k,
			Size:         int64(len(item.data)),
			LastModified: item.modified,
			ContentType:  item.contentType,
			Metadata:     item.meta,
		})
	}
	return res, nil
}

func (b *memBucket) Head(_ context.Context, key string) (*S3Object, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	item, ok := b.objs[key]
	if !ok {
		return nil, nil
	}
	return &S3Object{
		Key:          key,
		Size:         int64(len(item.data)),
		LastModified: item.modified,
		ContentType:  item.contentType,
		Metadata:     item.meta,
	}, nil
}

func (b *memBucket) Put(_ context.Context, key string, data []byte, contentType string, metadata map[string]string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	cp := make([]byte, len(data))
	copy(cp, data)
	metaCopy := make(map[string]string, len(metadata))
	for k, v := range metadata {
		metaCopy[k] = v
	}
	b.objs[key] = struct {
		data        []byte
		contentType string
		meta        map[string]string
		modified    time.Time
	}{data: cp, contentType: contentType, meta: metaCopy, modified: time.Now()}
	return nil
}

func (b *memBucket) Copy(_ context.Context, srcKey, dstKey, contentType string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	src, ok := b.objs[srcKey]
	if !ok {
		return nil
	}
	ct := src.contentType
	if contentType != "" {
		ct = contentType
	}
	cp := make([]byte, len(src.data))
	copy(cp, src.data)
	b.objs[dstKey] = struct {
		data        []byte
		contentType string
		meta        map[string]string
		modified    time.Time
	}{data: cp, contentType: ct, meta: src.meta, modified: time.Now()}
	return nil
}

func (b *memBucket) Delete(_ context.Context, keys []string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, k := range keys {
		delete(b.objs, k)
	}
	return nil
}

func (b *memBucket) PresignPut(_ context.Context, key, contentType string, _ map[string]string, _ time.Duration) (*PresignedPut, error) {
	return &PresignedPut{
		URL:     "https://r2.example.com/signed/" + key,
		Method:  http.MethodPut,
		Headers: map[string]string{"Content-Type": contentType},
	}, nil
}

// --- Synthetic image fixtures (matching yukilink test cases) ---

func buildTestJPEGWithExifAndComment() []byte {
	return []byte{
		0xff, 0xd8, // SOI
		0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53, 0x5f, 0x31, 0x32, 0x33, 0x34,
		0xff, 0xfe, 0x00, 0x0a, 0x53, 0x45, 0x43, 0x52, 0x45, 0x54, 0x31, 0x32,
		0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 0xaa, 0xbb, 0xff, 0xd9,
	}
}

func buildTestPNGWithMetadata() []byte {
	sig := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
	makeChunk := func(typ string, data []byte) []byte {
		out := make([]byte, 12+len(data))
		binary.BigEndian.PutUint32(out[0:4], uint32(len(data)))
		copy(out[4:8], typ)
		copy(out[8:], data)
		return out
	}
	var buf bytes.Buffer
	buf.Write(sig)
	buf.Write(makeChunk("IHDR", make([]byte, 13)))
	buf.Write(makeChunk("tEXt", []byte("Author\x00SecretUser")))
	buf.Write(makeChunk("eXIf", []byte("GPS_COORDS")))
	buf.Write(makeChunk("IDAT", []byte{1, 2, 3, 4}))
	buf.Write(makeChunk("IEND", nil))
	return buf.Bytes()
}

func TestStripImageMetadata(t *testing.T) {
	jpegRes := StripImageMetadata(buildTestJPEGWithExifAndComment())
	if !jpegRes.Stripped || len(jpegRes.Data) != 12 {
		t.Fatalf("expected stripped JPEG len 12, got stripped=%v len=%d", jpegRes.Stripped, len(jpegRes.Data))
	}

	pngRes := StripImageMetadata(buildTestPNGWithMetadata())
	if !pngRes.Stripped {
		t.Fatalf("expected PNG metadata to be stripped")
	}
	if bytes.Contains(pngRes.Data, []byte("SecretUser")) || bytes.Contains(pngRes.Data, []byte("GPS_COORDS")) {
		t.Fatalf("PNG metadata leaked into output")
	}
	if !bytes.Contains(pngRes.Data, []byte("IDAT")) {
		t.Fatalf("PNG image data missing")
	}
}

func TestStorageOperationsAndGuardrails(t *testing.T) {
	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x77}, 32))
	store := &memConfigStore{cfgs: map[int64]ConfigRecord{}}
	bucket := newMemBucket()

	// Set proxy hard cap to 1 MB to test 413 protection while verifying direct mode has NO limit.
	svc := NewService(store, box, func(PlainConfig) (Bucket, error) { return bucket, nil }, 1)
	ctx := context.Background()

	_, err := svc.SaveConfig(ctx, 1, SaveConfigInput{
		Endpoint:      "https://acct.r2.cloudflarestorage.com",
		Region:        "auto",
		Bucket:        "my-bucket",
		AccessKey:     "AKIA_TEST",
		SecretKey:     "SECRET_KEY_123456",
		PublicBaseURL: "https://img.example.com",
		HashLength:    16,
		UploadMode:    UploadModeDirect,
	})
	if err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	// 1. Direct presign succeeds with NO size restriction
	presign, err := svc.PresignDirectUpload(ctx, 1, PresignInput{
		Folder:      "2026/trips",
		FileName:    "a1b2c3d4e5f60708.jpg",
		ContentType: "image/jpeg",
		Stripped:    true,
	})
	if err != nil {
		t.Fatalf("PresignDirectUpload: %v", err)
	}
	if presign.File.URL != "https://img.example.com/2026/trips/a1b2c3d4e5f60708.jpg" {
		t.Fatalf("unexpected direct URL: %s", presign.File.URL)
	}

	// 2. Proxy upload via HTTP rejects > 1MB with 413 Payload Too Large
	h := NewHandler(svc, 1<<20, nil)
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(auth.WithUser(req.Context(), &auth.User{ID: 1})))
		})
	})
	h.RegisterRoutes(r)

	var bigBody bytes.Buffer
	mw := multipart.NewWriter(&bigBody)
	fw, _ := mw.CreateFormFile("file", "huge.bin")
	_, _ = fw.Write(bytes.Repeat([]byte("x"), (1<<20)+1024))
	_ = mw.Close()

	reqBig := httptest.NewRequest(http.MethodPost, "/upload", &bigBody)
	reqBig.Header.Set("Content-Type", mw.FormDataContentType())
	recBig := httptest.NewRecorder()
	r.ServeHTTP(recBig, reqBig)
	if recBig.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized proxy upload, got %d %s", recBig.Code, recBig.Body.String())
	}

	// 3. Proxy upload small JPEG strips EXIF & hashes filename
	entry, err := svc.ProxyUpload(ctx, 1, buildTestJPEGWithExifAndComment(), "IMG_001.JPG", "image/jpeg", "docs/2026", "", false)
	if err != nil {
		t.Fatalf("ProxyUpload: %v", err)
	}
	if !entry.MetadataStripped || entry.Size != 12 {
		t.Fatalf("expected stripped JPEG size 12, got %+v", entry)
	}

	// 4. Rename folder & verify old keys removed and new keys present
	_, _, moved, _, err := svc.RenameEntry(ctx, 1, "folder", "docs/2026", "docs/archive")
	if err != nil || moved != 1 {
		t.Fatalf("RenameEntry folder: moved=%d err=%v", moved, err)
	}
	listing, err := svc.ListDirectory(ctx, 1, "docs/archive", "")
	if err != nil || len(listing.Files) != 1 {
		t.Fatalf("expected 1 file in docs/archive, got %+v (err=%v)", listing, err)
	}

	// 5. Batch move & delete
	movedCnt, err := svc.MoveEntries(ctx, 1, []PathItem{{Type: "file", Path: listing.Files[0].Key}}, "gallery")
	if err != nil || movedCnt != 1 {
		t.Fatalf("MoveEntries: moved=%d err=%v", movedCnt, err)
	}
	delCnt, err := svc.DeleteEntries(ctx, 1, []PathItem{{Type: "folder", Path: "gallery"}})
	if err != nil || delCnt != 1 {
		t.Fatalf("DeleteEntries: deleted=%d err=%v", delCnt, err)
	}

	// 6. CommandBus Telegram image upload handler
	bus := messenger.NewCommandBus()
	mod := &Module{svc: svc, handler: h}
	mod.RegisterCommands(bus)

	reply, err := bus.Dispatch(ctx, &messenger.IncomingEvent{
		UserID: 1,
		Attachments: []messenger.Attachment{
			{
				Type:     "image",
				FileName: "tg.jpg",
				MimeType: "image/jpeg",
				Download: func(_ context.Context, _ int64) ([]byte, error) {
					return buildTestJPEGWithExifAndComment(), nil
				},
			},
		},
	})
	if err != nil || reply == nil || !strings.Contains(reply.Content, "https://img.example.com/telegram/") {
		t.Fatalf("expected TG image upload reply with direct URL, got %+v err=%v", reply, err)
	}
}

func buildSizedPNG(width, height uint32) []byte {
	sig := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], width)
	binary.BigEndian.PutUint32(ihdr[4:8], height)
	makeChunk := func(typ string, data []byte) []byte {
		out := make([]byte, 12+len(data))
		binary.BigEndian.PutUint32(out[0:4], uint32(len(data)))
		copy(out[4:8], typ)
		copy(out[8:], data)
		return out
	}
	var buf bytes.Buffer
	buf.Write(sig)
	buf.Write(makeChunk("IHDR", ihdr))
	buf.Write(makeChunk("IEND", nil))
	return buf.Bytes()
}

func TestGalleryGroupingAndDimensionCache(t *testing.T) {
	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x55}, 32))
	store := &memConfigStore{cfgs: map[int64]ConfigRecord{}}
	bucket := newMemBucket()
	svc := NewService(store, box, func(PlainConfig) (Bucket, error) { return bucket, nil }, 5)
	ctx := context.Background()

	_, err := svc.SaveConfig(ctx, 1, SaveConfigInput{
		Endpoint:      "https://acct.r2.cloudflarestorage.com",
		Region:        "auto",
		Bucket:        "album-bucket",
		AccessKey:     "AKIA_TEST",
		SecretKey:     "SECRET_KEY_123456",
		PublicBaseURL: "https://img.example.com",
		HashLength:    16,
		UploadMode:    UploadModeDirect,
	})
	if err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	// Verify PNG dimension extraction
	pngData := buildSizedPNG(1920, 1080)
	if w, h, ok := ExtractImageDimensions(pngData); !ok || w != 1920 || h != 1080 {
		t.Fatalf("ExtractImageDimensions PNG failed: w=%d h=%d ok=%v", w, h, ok)
	}

	// Seed objects across root, nested prefixes, and an empty .keep folder
	_ = bucket.Put(ctx, "root.png", pngData, "image/png", nil)
	_ = bucket.Put(ctx, "zeta/pic.png", pngData, "image/png", nil)
	_ = bucket.Put(ctx, "alpha/2026/a.png", pngData, "image/png", nil)
	_ = bucket.Put(ctx, "empty/.keep", []byte{}, "application/x-empty", nil)

	// Save dimensions including one stale size mismatch and one orphan key
	saved, err := svc.SaveObjectDimensions(ctx, 1, []ObjectDimensionInput{
		{Key: "root.png", Size: int64(len(pngData)), Width: 1920, Height: 1080},
		{Key: "zeta/pic.png", Size: 999999, Width: 100, Height: 100}, // wrong size -> must miss
		{Key: "deleted/orphan.png", Size: 123, Width: 50, Height: 50},
	})
	if err != nil || saved != 3 {
		t.Fatalf("SaveObjectDimensions: saved=%d err=%v", saved, err)
	}

	gallery, err := svc.ListGallery(ctx, 1, "")
	if err != nil {
		t.Fatalf("ListGallery: %v", err)
	}
	if gallery.TotalFiles != 3 || len(gallery.Groups) != 4 {
		t.Fatalf("expected 3 files across 4 groups, got total=%d groups=%d", gallery.TotalFiles, len(gallery.Groups))
	}

	// Root first, then lexicographical order: "", "alpha/2026/", "empty/", "zeta/"
	wantOrder := []string{"", "alpha/2026/", "empty/", "zeta/"}
	for i, want := range wantOrder {
		if gallery.Groups[i].Prefix != want {
			t.Fatalf("group[%d] = %q, want %q", i, gallery.Groups[i].Prefix, want)
		}
	}

	// Cache hit on root.png, cache miss on size-mismatched zeta/pic.png
	if gallery.Groups[0].Files[0].Width != 1920 || gallery.Groups[0].Files[0].Height != 1080 {
		t.Fatalf("expected cached dims 1920x1080 on root.png, got %+v", gallery.Groups[0].Files[0])
	}
	if gallery.Groups[3].Files[0].Width != 0 || gallery.Groups[3].Files[0].Height != 0 {
		t.Fatalf("expected size-mismatched dims to be ignored on zeta/pic.png, got %+v", gallery.Groups[3].Files[0])
	}

	// Orphan key should have been garbage-collected after full-bucket scan
	remainingDims, _ := store.ListObjectDims(ctx, 1)
	if _, stillThere := remainingDims["deleted/orphan.png"]; stillThere {
		t.Fatalf("expected orphan dim cache key to be cleaned up")
	}
}
