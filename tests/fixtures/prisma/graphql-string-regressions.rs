use crate::{parse_query, parse_schema};
use crate::query::{Definition, OperationDefinition, Selection, Value};

fn decoded(raw: &str) -> String {
    let query = format!("{{a(value:\"\"\"{}\"\"\")}}", raw);
    let doc = parse_query::<String>(&query).unwrap();
    let Definition::Operation(OperationDefinition::SelectionSet(set)) = &doc.definitions[0]
        else { panic!("unexpected document") };
    let Selection::Field(field) = &set.items[0] else { panic!("unexpected field") };
    let Value::String(value) = &field.arguments[0].1 else { panic!("unexpected value") };
    value.clone()
}

#[test]
fn mixed_unicode_indentation_is_safe() {
    assert_eq!(decoded("\n   A\n \u{2003}B\n"), "  A\n\u{2003}B");
    assert_eq!(decoded("\n  A\n \u{a0}B\n"), " A\n\u{a0}B");
}

#[test]
fn unicode_whitespace_is_content_not_indentation() {
    for c in ['\u{a0}', '\u{1680}', '\u{2000}', '\u{2003}', '\u{202f}', '\u{205f}', '\u{3000}'] {
        assert_eq!(decoded(&format!("\n{}\n", c)), c.to_string());
    }
}

#[test]
fn first_line_content_and_trailing_spaces_are_preserved() {
    assert_eq!(decoded("  first  \n  second\n"), "  first  \nsecond");
    assert_eq!(decoded(" first "), " first ");
}

#[test]
fn only_ascii_blank_boundary_lines_are_removed() {
    assert_eq!(decoded(" \t\n\n  A\n\n \t\n"), "A");
    assert_eq!(decoded("\n  A\n\n  B\n"), "A\n\nB");
}

#[test]
fn empty_and_ascii_whitespace_only_strings_are_empty() {
    for raw in ["", " ", "\t", "\n", "\r", "\r\n", " \t\r\n\t\r \n"] {
        assert_eq!(decoded(raw), "");
    }
}

#[test]
fn tab_and_space_indentation_counts_characters() {
    assert_eq!(decoded("\n\t A\n\t B\n"), "A\nB");
    assert_eq!(decoded("\n\t A\n   B\n"), "A\n B");
    assert_eq!(decoded("\n    A\n \n    B\n"), "A\n\nB");
}

#[test]
fn carriage_return_line_endings_are_normalized() {
    assert_eq!(decoded("\r  A\r  B\r"), "A\nB");
    assert_eq!(decoded("\r\n  A\r  B\n  C\r\n"), "A\nB\nC");
}

#[test]
fn escaped_triple_quotes_are_decoded_on_every_line() {
    assert_eq!(decoded("first \\\"\"\"\n  next \\\"\"\"\n"), "first \"\"\"\nnext \"\"\"");
}

#[test]
fn unicode_indent_corpus_covers_query_and_schema_entries() {
    for c in ['\u{a0}', '\u{2003}', '\u{3000}', '\u{1f642}', '\u{e9}', '\u{301}'] {
        for indent in 0..16 {
            let raw = format!("\n{}A\n {}B\n", " ".repeat(indent), c);
            let expected = format!("{}A\n{}{}B", " ".repeat(indent.saturating_sub(1)), if indent == 0 { " " } else { "" }, c);
            assert_eq!(decoded(&raw), expected);
            let schema = format!("\"\"\"{}\"\"\" type Q {{ a: String }}", raw);
            let doc = parse_schema::<String>(&schema).unwrap();
            let crate::schema::Definition::TypeDefinition(crate::schema::TypeDefinition::Object(obj)) =
                &doc.definitions[0] else { panic!("unexpected schema") };
            assert_eq!(obj.description.as_ref().unwrap(), &expected);
        }
    }
}
