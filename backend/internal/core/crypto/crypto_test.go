package crypto

import (
	"bytes"
	"testing"
)

func TestBoxEncryptDecrypt(t *testing.T) {
	key := bytes.Repeat([]byte{0x42}, 32)
	box, err := NewBox(key)
	if err != nil {
		t.Fatalf("NewBox: %v", err)
	}

	plain := []byte(`{"bot_token":"123456:ABC-secret","chat_id":"98765"}`)
	c1, err := box.Encrypt(plain)
	if err != nil {
		t.Fatalf("Encrypt 1: %v", err)
	}
	c2, err := box.Encrypt(plain)
	if err != nil {
		t.Fatalf("Encrypt 2: %v", err)
	}
	if c1 == c2 {
		t.Fatalf("expected distinct nonces to produce different ciphertexts")
	}

	got, err := box.Decrypt(c1)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("plaintext mismatch: got %q want %q", got, plain)
	}

	// Tampered ciphertext must fail authentication.
	// Flip a non-trailing base64 character so decoded ciphertext bytes are guaranteed to differ.
	tampered := "A" + c1[1:]
	if tampered == c1 {
		tampered = "B" + c1[1:]
	}
	if _, err := box.Decrypt(tampered); err == nil {
		t.Fatalf("expected error decrypting tampered ciphertext")
	}
}

func TestBoxSignVerify(t *testing.T) {
	key := bytes.Repeat([]byte{0x24}, 32)
	box, err := NewBox(key)
	if err != nil {
		t.Fatalf("NewBox: %v", err)
	}
	payload := []byte("session-payload")
	sig := box.Sign(payload)
	if !box.Verify(payload, sig) {
		t.Fatalf("expected signature verification to pass")
	}
	if box.Verify([]byte("other-payload"), sig) {
		t.Fatalf("expected signature verification to fail on modified payload")
	}
}
