use std::sync::LazyLock;

use regex::Regex;

use super::{Reading, Suggestion};
use crate::custody::{normalize_mac, normalize_serial};

const LOW_CONFIDENCE: f32 = 0.80;
const MAX_SUGGESTIONS: usize = 32;

static LABELS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?P<label>(?:WAN\s+|LAN\s+|WI[ -]?FI\s+)?MAC(?:\s+ADDRESS)?|S\s*/\s*N|SERIAL(?:\s+(?:NUMBER|NO\.?))?|SN|MODELO?|FABRICANTE|MANUFACTURER)(?:\s*[:=]\s*|\s+|$)")
        .expect("expressão de rótulos válida")
});

static SERIAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9A-Za-z][0-9A-Za-z._/-]{0,127}$").expect("expressão de serial válida")
});

struct Word {
    start: usize,
    end: usize,
    confidence: Option<f32>,
}

#[derive(Default)]
struct Line {
    text: String,
    words: Vec<Word>,
}

impl Line {
    fn append(&mut self, text: &str, confidence: Option<f32>) {
        if !self.text.is_empty() {
            self.text.push(' ');
        }
        let start = self.text.len();
        self.text.push_str(text);
        self.words.push(Word {
            start,
            end: self.text.len(),
            confidence,
        });
    }

    fn confidence(&self, start: usize, end: usize) -> Option<f32> {
        self.words
            .iter()
            .filter(|word| word.end > start && word.start < end)
            .try_fold(1.0_f32, |min, word| Some(min.min(word.confidence?)))
    }
}

pub fn parse(tsv: &str, barcode: Option<&str>) -> Reading {
    let mut lines = Vec::new();
    let mut current_key = "";
    for row in tsv.lines().skip(1) {
        let columns: Vec<_> = row.splitn(12, '\t').collect();
        if columns.len() != 12 || columns[0] != "5" || columns[11].trim().is_empty() {
            continue;
        }
        let key_end = columns[..5]
            .iter()
            .map(|value| value.len() + 1)
            .sum::<usize>()
            - 1;
        let key = &row[..key_end];
        if current_key != key {
            lines.push(Line::default());
            current_key = key;
        }
        let confidence = columns[10]
            .parse::<f32>()
            .ok()
            .filter(|value| (0.0..=100.0).contains(value))
            .map(|value| value / 100.0);
        lines
            .last_mut()
            .expect("palavra pertence a uma linha")
            .append(columns[11], confidence);
    }

    let mut suggestions = Vec::new();
    let mut warnings = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let labels: Vec<_> = LABELS.captures_iter(&line.text).collect();
        for (label_index, label) in labels.iter().enumerate() {
            if suggestions.len() >= MAX_SUGGESTIONS {
                push_warning(&mut warnings, "TOO_MANY_VALUES");
                break;
            }
            let marker = label.get(0).expect("rótulo encontrado");
            let end = labels
                .get(label_index + 1)
                .and_then(|next| next.get(0))
                .map_or(line.text.len(), |next| next.start());
            let tail = &line.text[marker.end()..end];
            let (source, start, raw) = if tail.trim().is_empty() && end == line.text.len() {
                match lines
                    .get(index + 1)
                    .filter(|next| !LABELS.is_match(&next.text))
                {
                    Some(next) => (next, 0, next.text.as_str()),
                    None => (line, marker.end(), tail),
                }
            } else {
                (line, marker.end(), tail)
            };
            let start = start + raw.len() - raw.trim_start().len();
            let raw = raw.trim();
            let label = label["label"].to_owned();
            let upper = label.to_ascii_uppercase();
            let (kind, normalized) = if upper.contains("MAC") {
                ("MAC", normalize_mac(raw).ok())
            } else if matches!(upper.as_str(), "MODELO" | "MODEL") {
                ("MODEL", descriptive_value(raw))
            } else if matches!(upper.as_str(), "FABRICANTE" | "MANUFACTURER") {
                ("MANUFACTURER", descriptive_value(raw))
            } else {
                (
                    "SERIAL",
                    SERIAL.is_match(raw).then(|| normalize_serial(raw)),
                )
            };
            let Some(normalized_value) = normalized else {
                push_warning(&mut warnings, "UNREADABLE_FIELD");
                continue;
            };
            let confidence = source.confidence(start, start + raw.len());
            if confidence.is_none_or(|value| value < LOW_CONFIDENCE) {
                push_warning(&mut warnings, "LOW_CONFIDENCE");
            }
            suggestions.push(Suggestion {
                kind,
                label,
                raw_value: raw.into(),
                normalized_value,
                confidence,
            });
        }
    }
    let serials = suggestions
        .iter()
        .filter(|item| item.kind == "SERIAL")
        .collect::<Vec<_>>();
    if serials.is_empty() {
        push_warning(&mut warnings, "SERIAL_MISSING");
    } else if serials
        .iter()
        .any(|item| item.normalized_value != serials[0].normalized_value)
    {
        push_warning(&mut warnings, "MULTIPLE_SERIALS");
    }
    let macs = suggestions
        .iter()
        .filter(|item| item.kind == "MAC")
        .collect::<Vec<_>>();
    if macs.is_empty() {
        push_warning(&mut warnings, "MAC_MISSING");
    } else if let Some(barcode_mac) = barcode.and_then(|value| normalize_mac(value.trim()).ok())
        && macs.iter().all(|item| item.normalized_value != barcode_mac)
    {
        push_warning(&mut warnings, "BARCODE_MAC_MISMATCH");
    }
    Reading {
        suggestions,
        warnings,
    }
}

fn descriptive_value(raw: &str) -> Option<String> {
    (!raw.is_empty() && raw.len() <= 128 && !raw.chars().any(char::is_control))
        .then(|| raw.to_owned())
}

fn push_warning(warnings: &mut Vec<&'static str>, warning: &'static str) {
    if !warnings.contains(&warning) {
        warnings.push(warning);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tsv(lines: &[&[(&str, u8)]]) -> String {
        let mut output = String::from("level\tpage_num\n");
        for (line, words) in lines.iter().enumerate() {
            for (index, (word, confidence)) in words.iter().enumerate() {
                output.push_str(&format!(
                    "5\t1\t1\t1\t{line}\t{index}\t0\t0\t0\t0\t{confidence}\t{word}\n"
                ));
            }
        }
        output
    }

    #[test]
    fn keeps_serial_and_multiple_macs_as_separate_suggestions() {
        let reading = parse(
            &tsv(&[
                &[
                    ("S/N:", 95),
                    ("000I-O1", 92),
                    ("WAN", 97),
                    ("MAC:", 97),
                    ("AA:bb:cc:dd:ee:01", 93),
                ],
                &[("LAN", 93), ("MAC", 95)],
                &[("AA-BB-CC-DD-EE-02", 90)],
            ]),
            Some("AABBCCDDEE02"),
        );
        assert_eq!(reading.suggestions.len(), 3);
        assert_eq!(reading.suggestions[0].normalized_value, "000I-O1");
        assert_eq!(reading.suggestions[0].confidence, Some(0.92));
        assert_eq!(reading.suggestions[1].normalized_value, "AABBCCDDEE01");
        assert_eq!(reading.suggestions[2].normalized_value, "AABBCCDDEE02");
        assert!(reading.warnings.is_empty(), "{:?}", reading.warnings);
    }

    #[test]
    fn reports_missing_ambiguous_and_conflicting_fields_without_autocorrection() {
        let empty = parse(&tsv(&[&[("AABBCCDDEE01", 92), ("001-42", 91)]]), None);
        assert!(empty.suggestions.is_empty());
        assert!(empty.warnings.contains(&"SERIAL_MISSING"));
        assert!(empty.warnings.contains(&"MAC_MISSING"));
        let ambiguous = parse(
            &tsv(&[
                &[("SN:", 94), ("00O11", 45), ("SN:", 94), ("00011", 90)],
                &[("MAC:", 92), ("AABBCCDDEE01", 95)],
                &[("MAC:", 95), ("AABBCCDDEE0O", 95)],
            ]),
            Some("AABBCCDDEE02"),
        );
        assert_eq!(ambiguous.suggestions[0].raw_value, "00O11");
        for warning in [
            "LOW_CONFIDENCE",
            "MULTIPLE_SERIALS",
            "BARCODE_MAC_MISMATCH",
            "UNREADABLE_FIELD",
        ] {
            assert!(ambiguous.warnings.contains(&warning), "{warning}");
        }
    }
}
