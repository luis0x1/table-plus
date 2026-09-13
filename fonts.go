package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"unicode/utf16"
)

// ListSystemFonts returns the family names embedded in fonts installed in the
// standard OS locations. Reading the SFNT name table keeps this portable and
// avoids returning file names that do not match the CSS font-family name.
func (a *App) ListSystemFonts() []string {
	return scanSystemFonts()
}

func scanSystemFonts() []string {
	home, _ := os.UserHomeDir()
	directories := []string{}
	switch runtime.GOOS {
	case "darwin":
		directories = []string{"/System/Library/Fonts", "/Library/Fonts", filepath.Join(home, "Library", "Fonts")}
	case "windows":
		directories = []string{filepath.Join(os.Getenv("WINDIR"), "Fonts"), filepath.Join(os.Getenv("LOCALAPPDATA"), "Microsoft", "Windows", "Fonts")}
	default:
		directories = []string{"/usr/share/fonts", "/usr/local/share/fonts", filepath.Join(home, ".fonts"), filepath.Join(home, ".local", "share", "fonts")}
	}

	families := make(map[string]string)
	for _, directory := range directories {
		if directory == "" {
			continue
		}
		_ = filepath.WalkDir(directory, func(path string, entry os.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return nil
			}
			switch strings.ToLower(filepath.Ext(path)) {
			case ".ttf", ".otf", ".ttc", ".otc":
				for _, family := range fontFamilies(path) {
					key := strings.ToLower(family)
					if _, exists := families[key]; !exists {
						families[key] = family
					}
				}
			}
			return nil
		})
	}
	result := make([]string, 0, len(families))
	for _, family := range families {
		result = append(result, family)
	}
	sort.Slice(result, func(i, j int) bool { return strings.ToLower(result[i]) < strings.ToLower(result[j]) })
	return result
}

func fontFamilies(path string) []string {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	header, err := readFontBytes(file, 0, 12)
	if err != nil {
		return nil
	}
	offsets := []int64{0}
	if string(header[:4]) == "ttcf" {
		count := int(binary.BigEndian.Uint32(header[8:12]))
		if count <= 0 || count > 256 {
			return nil
		}
		table, readErr := readFontBytes(file, 12, count*4)
		if readErr != nil {
			return nil
		}
		offsets = make([]int64, count)
		for index := range offsets {
			offsets[index] = int64(binary.BigEndian.Uint32(table[index*4 : index*4+4]))
		}
	}

	seen := make(map[string]bool)
	result := []string{}
	for _, offset := range offsets {
		if family := sfntFamily(file, offset); family != "" && !seen[strings.ToLower(family)] {
			seen[strings.ToLower(family)] = true
			result = append(result, family)
		}
	}
	return result
}

func sfntFamily(file *os.File, offset int64) string {
	header, err := readFontBytes(file, offset, 12)
	if err != nil {
		return ""
	}
	tableCount := int(binary.BigEndian.Uint16(header[4:6]))
	if tableCount <= 0 || tableCount > 512 {
		return ""
	}
	records, err := readFontBytes(file, offset+12, tableCount*16)
	if err != nil {
		return ""
	}
	var nameOffset int64 = -1
	for index := 0; index < tableCount; index++ {
		record := records[index*16 : index*16+16]
		if string(record[:4]) == "name" {
			nameOffset = int64(binary.BigEndian.Uint32(record[8:12]))
			break
		}
	}
	if nameOffset < 0 {
		return ""
	}
	nameHeader, err := readFontBytes(file, nameOffset, 6)
	if err != nil {
		return ""
	}
	nameCount := int(binary.BigEndian.Uint16(nameHeader[2:4]))
	stringOffset := int64(binary.BigEndian.Uint16(nameHeader[4:6]))
	if nameCount <= 0 || nameCount > 4096 {
		return ""
	}
	nameRecords, err := readFontBytes(file, nameOffset+6, nameCount*12)
	if err != nil {
		return ""
	}
	best, bestScore := "", -1
	for index := 0; index < nameCount; index++ {
		record := nameRecords[index*12 : index*12+12]
		platform := binary.BigEndian.Uint16(record[0:2])
		language := binary.BigEndian.Uint16(record[4:6])
		nameID := binary.BigEndian.Uint16(record[6:8])
		if nameID != 1 && nameID != 16 {
			continue
		}
		length := int(binary.BigEndian.Uint16(record[8:10]))
		position := nameOffset + stringOffset + int64(binary.BigEndian.Uint16(record[10:12]))
		raw, readErr := readFontBytes(file, position, length)
		if readErr != nil {
			continue
		}
		family := decodeFontName(platform, raw)
		if !validFontFamily(family) {
			continue
		}
		score := 0
		if nameID == 16 {
			score += 100
		}
		if platform == 0 || platform == 3 {
			score += 20
		}
		if language == 0x0409 || language == 0 {
			score += 5
		}
		if score > bestScore {
			best, bestScore = family, score
		}
	}
	return best
}

func readFontBytes(file *os.File, offset int64, size int) ([]byte, error) {
	if offset < 0 || size < 0 || size > 8<<20 {
		return nil, os.ErrInvalid
	}
	data := make([]byte, size)
	_, err := file.ReadAt(data, offset)
	return data, err
}

func decodeFontName(platform uint16, data []byte) string {
	if platform == 0 || platform == 3 {
		data = data[:len(data)-len(data)%2]
		encoded := make([]uint16, len(data)/2)
		for index := range encoded {
			encoded[index] = binary.BigEndian.Uint16(data[index*2 : index*2+2])
		}
		return strings.TrimSpace(string(utf16.Decode(encoded)))
	}
	return strings.TrimSpace(string(data))
}
