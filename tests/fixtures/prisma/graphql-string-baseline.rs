use crate::parse_query;

#[test]
fn mixed_unicode_indentation_panics_before_fix() {
    let query = "{a(value:\"\"\"\n   A\n \u{2003}B\n\"\"\")}";
    assert!(std::panic::catch_unwind(|| parse_query::<String>(query)).is_err());
}

#[test]
fn nonbreaking_space_indentation_panics_before_fix() {
    let query = "{a(value:\"\"\"\n  A\n \u{a0}B\n\"\"\")}";
    assert!(std::panic::catch_unwind(|| parse_query::<String>(query)).is_err());
}

#[test]
fn first_line_content_is_trimmed_before_fix() {
    let query = "{a(value:\"\"\"  first  \n  second\n\"\"\")}";
    let doc = parse_query::<String>(query).unwrap();
    let crate::query::Definition::Operation(crate::query::OperationDefinition::SelectionSet(set)) =
        &doc.definitions[0] else { panic!("unexpected document") };
    let crate::query::Selection::Field(field) = &set.items[0] else { panic!("unexpected field") };
    assert_eq!(field.arguments[0].1, crate::query::Value::String("first\nsecond\n".into()));
}
