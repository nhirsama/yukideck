package storage

import (
	"bytes"
	"encoding/binary"
)

type StripResult struct {
	Data         []byte
	Stripped     bool
	RemovedBytes int
}

// StripImageMetadata losslessly removes EXIF, GPS, XMP, IPTC, comments, and timestamps
// from JPEG (preserving EXIF Orientation), PNG, and WebP at the binary container level.
func StripImageMetadata(input []byte) StripResult {
	if len(input) < 12 {
		return StripResult{Data: input}
	}
	if isJPEG(input) {
		return stripJPEGMetadata(input)
	}
	if isPNG(input) {
		return stripPNGMetadata(input)
	}
	if isWebP(input) {
		return stripWebPMetadata(input)
	}
	return StripResult{Data: input}
}

func isJPEG(b []byte) bool {
	return len(b) >= 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff
}

func isPNG(b []byte) bool {
	return len(b) >= 8 && bytes.Equal(b[:8], []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a})
}

func isWebP(b []byte) bool {
	return len(b) >= 12 && string(b[0:4]) == "RIFF" && string(b[8:12]) == "WEBP"
}

func extractJPEGExifOrientation(payload []byte) (uint16, bool) {
	if len(payload) < 28 || !bytes.Equal(payload[:6], []byte{'E', 'x', 'i', 'f', 0x00, 0x00}) {
		return 0, false
	}
	tiff := payload[6:]
	var bo binary.ByteOrder
	switch binary.BigEndian.Uint16(tiff[0:2]) {
	case 0x4949: // 'II'
		bo = binary.LittleEndian
	case 0x4d4d: // 'MM'
		bo = binary.BigEndian
	default:
		return 0, false
	}
	if bo.Uint16(tiff[2:4]) != 0x002a {
		return 0, false
	}
	ifdOffset := int(bo.Uint32(tiff[4:8]))
	if ifdOffset < 0 || ifdOffset+2 > len(tiff) {
		return 0, false
	}
	count := int(bo.Uint16(tiff[ifdOffset : ifdOffset+2]))
	for i := 0; i < count; i++ {
		off := ifdOffset + 2 + i*12
		if off+12 > len(tiff) {
			break
		}
		if bo.Uint16(tiff[off:off+2]) == 0x0112 {
			val := bo.Uint16(tiff[off+8 : off+10])
			if val >= 1 && val <= 8 {
				return val, true
			}
		}
	}
	return 0, false
}

func buildMinimalOrientationApp1(orientation uint16) []byte {
	out := make([]byte, 36)
	out[0], out[1] = 0xff, 0xe1
	binary.BigEndian.PutUint16(out[2:4], 34)
	copy(out[4:10], []byte{'E', 'x', 'i', 'f', 0x00, 0x00})
	out[10], out[11] = 0x4d, 0x4d
	binary.BigEndian.PutUint16(out[12:14], 0x002a)
	binary.BigEndian.PutUint32(out[14:18], 8)
	binary.BigEndian.PutUint16(out[18:20], 1)
	binary.BigEndian.PutUint16(out[20:22], 0x0112)
	binary.BigEndian.PutUint16(out[22:24], 3)
	binary.BigEndian.PutUint32(out[24:28], 1)
	binary.BigEndian.PutUint16(out[28:30], orientation)
	binary.BigEndian.PutUint16(out[30:32], 0)
	binary.BigEndian.PutUint32(out[32:36], 0)
	return out
}

func stripJPEGMetadata(input []byte) StripResult {
	var out bytes.Buffer
	out.Grow(len(input))
	out.Write(input[:2]) // SOI

	pos := 2
	stripped := false
	preservedOrientation := false

	for pos < len(input) {
		if input[pos] != 0xff {
			return StripResult{Data: input}
		}
		for pos < len(input) && input[pos] == 0xff {
			pos++
		}
		if pos >= len(input) {
			break
		}
		marker := input[pos]
		pos++

		// EOI or SOS: copy remainder verbatim
		if marker == 0xd9 || marker == 0xda {
			out.Write(input[pos-2:])
			break
		}
		// Standalone markers without payload length
		if marker == 0xd8 || marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7) {
			out.Write(input[pos-2 : pos])
			continue
		}
		if pos+2 > len(input) {
			return StripResult{Data: input}
		}
		segLen := int(binary.BigEndian.Uint16(input[pos : pos+2]))
		if segLen < 2 || pos+segLen > len(input) {
			return StripResult{Data: input}
		}
		segStart := pos - 2
		segEnd := pos + segLen

		removable := marker == 0xe1 || marker == 0xed || marker == 0xfe ||
			(marker >= 0xe3 && marker <= 0xec) || marker == 0xef
		if removable {
			stripped = true
			if marker == 0xe1 && !preservedOrientation {
				if ori, ok := extractJPEGExifOrientation(input[pos+2 : segEnd]); ok && ori > 1 {
					preservedOrientation = true
					out.Write(buildMinimalOrientationApp1(ori))
				}
			}
		} else {
			out.Write(input[segStart:segEnd])
		}
		pos = segEnd
	}

	if !stripped {
		return StripResult{Data: input}
	}
	res := out.Bytes()
	removed := len(input) - len(res)
	if removed < 0 {
		removed = 0
	}
	return StripResult{Data: res, Stripped: true, RemovedBytes: removed}
}

var pngStripChunks = map[string]struct{}{
	"eXIf": {},
	"tEXt": {},
	"zTXt": {},
	"iTXt": {},
	"tIME": {},
}

func stripPNGMetadata(input []byte) StripResult {
	var out bytes.Buffer
	out.Grow(len(input))
	out.Write(input[:8])

	pos := 8
	stripped := false
	for pos+12 <= len(input) {
		chunkLen := int(binary.BigEndian.Uint32(input[pos : pos+4]))
		total := 12 + chunkLen
		if chunkLen < 0 || pos+total > len(input) {
			return StripResult{Data: input}
		}
		chunkType := string(input[pos+4 : pos+8])
		if _, drop := pngStripChunks[chunkType]; drop {
			stripped = true
		} else {
			out.Write(input[pos : pos+total])
		}
		pos += total
		if chunkType == "IEND" {
			break
		}
	}
	if !stripped {
		return StripResult{Data: input}
	}
	res := out.Bytes()
	removed := len(input) - len(res)
	if removed < 0 {
		removed = 0
	}
	return StripResult{Data: res, Stripped: true, RemovedBytes: removed}
}

func stripWebPMetadata(input []byte) StripResult {
	var out bytes.Buffer
	out.Grow(len(input))
	out.Write(input[:12])

	pos := 12
	stripped := false
	for pos+8 <= len(input) {
		fourCC := string(input[pos : pos+4])
		chunkSize := int(binary.LittleEndian.Uint32(input[pos+4 : pos+8]))
		padded := chunkSize + (chunkSize & 1)
		total := 8 + padded
		if chunkSize < 0 || pos+total > len(input) {
			return StripResult{Data: input}
		}

		if fourCC == "EXIF" || fourCC == "XMP " {
			stripped = true
		} else if fourCC == "VP8X" && chunkSize >= 10 {
			cp := make([]byte, total)
			copy(cp, input[pos:pos+total])
			cp[8] &^= 0x0c // clear EXIF (0x08) and XMP (0x04) bits
			out.Write(cp)
		} else {
			out.Write(input[pos : pos+total])
		}
		pos += total
	}

	if !stripped {
		return StripResult{Data: input}
	}
	res := out.Bytes()
	binary.LittleEndian.PutUint32(res[4:8], uint32(len(res)-8))
	removed := len(input) - len(res)
	if removed < 0 {
		removed = 0
	}
	return StripResult{Data: res, Stripped: true, RemovedBytes: removed}
}

// ExtractImageDimensions reads pixel width & height from PNG, GIF, WebP, or JPEG headers
// (accounting for JPEG EXIF orientation 5-8) without full image decoding.
func ExtractImageDimensions(input []byte) (int, int, bool) {
	if len(input) < 12 {
		return 0, 0, false
	}

	// PNG: IHDR width at [16:20], height at [20:24]
	if isPNG(input) && len(input) >= 24 {
		w := int(binary.BigEndian.Uint32(input[16:20]))
		h := int(binary.BigEndian.Uint32(input[20:24]))
		if w > 0 && h > 0 {
			return w, h, true
		}
		return 0, 0, false
	}

	// GIF: GIF87a / GIF89a width at [6:8], height at [8:10] (LE)
	if len(input) >= 10 && string(input[0:4]) == "GIF8" {
		w := int(binary.LittleEndian.Uint16(input[6:8]))
		h := int(binary.LittleEndian.Uint16(input[8:10]))
		if w > 0 && h > 0 {
			return w, h, true
		}
		return 0, 0, false
	}

	// WebP: VP8X / VP8L / VP8
	if isWebP(input) && len(input) >= 30 {
		chunk := string(input[12:16])
		switch chunk {
		case "VP8X":
			w := 1 + (int(input[24]) | (int(input[25]) << 8) | (int(input[26]) << 16))
			h := 1 + (int(input[27]) | (int(input[28]) << 8) | (int(input[29]) << 16))
			if w > 0 && h > 0 {
				return w, h, true
			}
		case "VP8L":
			if input[20] == 0x2f {
				bits := binary.LittleEndian.Uint32(input[21:25])
				w := int(bits&0x3fff) + 1
				h := int((bits>>14)&0x3fff) + 1
				if w > 0 && h > 0 {
					return w, h, true
				}
			}
		case "VP8 ":
			if input[23] == 0x9d && input[24] == 0x01 && input[25] == 0x2a {
				w := int(binary.LittleEndian.Uint16(input[26:28]) & 0x3fff)
				h := int(binary.LittleEndian.Uint16(input[28:30]) & 0x3fff)
				if w > 0 && h > 0 {
					return w, h, true
				}
			}
		}
		return 0, 0, false
	}

	// JPEG: scan SOF markers + EXIF orientation
	if isJPEG(input) {
		pos := 2
		var orientation uint16 = 1
		for pos < len(input) {
			if input[pos] != 0xff {
				break
			}
			for pos < len(input) && input[pos] == 0xff {
				pos++
			}
			if pos >= len(input) {
				break
			}
			marker := input[pos]
			pos++
			if marker == 0xd9 || marker == 0xda {
				break
			}
			if marker == 0xd8 || marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7) {
				continue
			}
			if pos+2 > len(input) {
				break
			}
			segLen := int(binary.BigEndian.Uint16(input[pos : pos+2]))
			if segLen < 2 || pos+segLen > len(input) {
				break
			}
			if marker == 0xe1 {
				if ori, ok := extractJPEGExifOrientation(input[pos+2 : pos+segLen]); ok {
					orientation = ori
				}
			}
			isSOF := (marker >= 0xc0 && marker <= 0xc3) ||
				(marker >= 0xc5 && marker <= 0xc7) ||
				(marker >= 0xc9 && marker <= 0xcb) ||
				(marker >= 0xcd && marker <= 0xcf)
			if isSOF && segLen >= 7 {
				h := int(binary.BigEndian.Uint16(input[pos+3 : pos+5]))
				w := int(binary.BigEndian.Uint16(input[pos+5 : pos+7]))
				if w > 0 && h > 0 {
					if orientation >= 5 && orientation <= 8 {
						return h, w, true
					}
					return w, h, true
				}
				break
			}
			pos += segLen
		}
	}
	return 0, 0, false
}
