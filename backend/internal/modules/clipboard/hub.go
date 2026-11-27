package clipboard

import (
	"sync"
)

const (
	maxSubscribersPerUser = 16
	subscriberBufferSize  = 32
)

type subscriber struct {
	id       uint64
	userID   int64
	clientID string
	ch       chan ClipboardEvent
}

// Hub is an in-memory per-user pub/sub hub for SSE clipboard updates.
type Hub struct {
	mu     sync.RWMutex
	nextID uint64
	subs   map[int64][]*subscriber
	closed bool
}

func NewHub() *Hub {
	return &Hub{
		subs: make(map[int64][]*subscriber),
	}
}

func (h *Hub) Subscribe(userID int64, clientID string) *subscriber {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.nextID++
	sub := &subscriber{
		id:       h.nextID,
		userID:   userID,
		clientID: clientID,
		ch:       make(chan ClipboardEvent, subscriberBufferSize),
	}
	if h.closed {
		close(sub.ch)
		return sub
	}

	list := h.subs[userID]
	// Evict oldest connection(s) if user exceeds per-user guardrail.
	for len(list) >= maxSubscribersPerUser {
		oldest := list[0]
		list = list[1:]
		close(oldest.ch)
	}
	h.subs[userID] = append(list, sub)
	return sub
}

func (h *Hub) Unsubscribe(sub *subscriber) {
	if sub == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	list := h.subs[sub.userID]
	for i, s := range list {
		if s.id == sub.id {
			list = append(list[:i], list[i+1:]...)
			close(s.ch)
			break
		}
	}
	if len(list) == 0 {
		delete(h.subs, sub.userID)
	} else {
		h.subs[sub.userID] = list
	}
}

func (h *Hub) Broadcast(userID int64, ev ClipboardEvent) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if h.closed {
		return
	}
	list := h.subs[userID]
	for _, sub := range list {
		// Skip echoing back to the originating tab when client_id matches.
		if ev.ClientID != "" && sub.clientID != "" && sub.clientID == ev.ClientID {
			continue
		}
		select {
		case sub.ch <- ev:
		default:
			// Drop for slow consumers instead of blocking writers.
		}
	}
}

func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	for uid, list := range h.subs {
		for _, sub := range list {
			close(sub.ch)
		}
		delete(h.subs, uid)
	}
}
