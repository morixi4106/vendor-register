#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use tiberius::{ColumnData, TableValue, TableValueRow};

    #[derive(TableValueRow)]
    struct ScalarRow { id: i32, active: bool, score: f64 }

    #[derive(TableValueRow)]
    struct OwnedRow { label: String, bytes: Vec<u8>, optional: Option<String> }

    #[derive(TableValueRow)]
    struct BorrowedRow<'a> { label: &'a str, bytes: &'a [u8], optional: Option<&'a str> }

    #[derive(TableValueRow)]
    struct EmptyRow {}

    #[derive(TableValueRow)]
    struct LabelledRow {
        #[colname = "quoted\"; label --"]
        r#type: String,
        #[colname = "Second"]
        number: i32,
    }

    #[test]
    fn scalar_columns_keep_order_and_type() {
        let data = vec![ScalarRow { id: 42, active: true, score: 1.5 }].into_sql();
        assert_eq!(data.db_type(), "ScalarRow");
        assert_eq!(data.rows().len(), 1);
        assert_eq!(data.rows()[0].columns(), &[ColumnData::I32(Some(42)), ColumnData::Bit(Some(true)), ColumnData::F64(Some(1.5))]);
    }

    #[test]
    fn owned_columns_survive_input_drop() {
        let data = vec![OwnedRow { label: "owned".to_owned(), bytes: vec![0, 1, 255], optional: Some("value".to_owned()) }].into_sql();
        assert_eq!(data.rows()[0].columns(), &[ColumnData::String(Some(Cow::Owned("owned".to_owned()))), ColumnData::Binary(Some(Cow::Owned(vec![0, 1, 255]))), ColumnData::String(Some(Cow::Owned("value".to_owned())))]);
        assert!(matches!(&data.rows()[0].columns()[0], ColumnData::String(Some(Cow::Owned(_)))));
        assert!(matches!(&data.rows()[0].columns()[1], ColumnData::Binary(Some(Cow::Owned(_)))));
    }

    #[test]
    fn borrowed_columns_keep_the_declared_lifetime() {
        let text = String::from("borrowed");
        let bytes = vec![8, 9];
        let data = vec![BorrowedRow { label: &text, bytes: &bytes, optional: Some(&text) }].into_sql();
        assert_eq!(data.rows()[0].columns(), &[ColumnData::String(Some(Cow::Borrowed("borrowed"))), ColumnData::Binary(Some(Cow::Borrowed(&[8u8, 9][..]))), ColumnData::String(Some(Cow::Borrowed("borrowed")))]);
        assert!(matches!(&data.rows()[0].columns()[0], ColumnData::String(Some(Cow::Borrowed(_)))));
    }

    #[test]
    fn optional_columns_preserve_null_values() {
        let data = vec![OwnedRow { label: "".to_owned(), bytes: vec![], optional: None }].into_sql();
        assert_eq!(data.rows()[0].columns()[2], ColumnData::String(None));
        let borrowed = vec![BorrowedRow { label: "", bytes: &[], optional: None }].into_sql();
        assert_eq!(borrowed.rows()[0].columns()[2], ColumnData::String(None));
    }

    #[test]
    fn empty_named_struct_has_no_bound_columns() {
        let data = vec![EmptyRow {}].into_sql();
        assert_eq!(data.db_type(), "EmptyRow");
        assert_eq!(data.rows().len(), 1);
        assert!(data.rows()[0].columns().is_empty());
    }

    #[test]
    fn column_attributes_do_not_change_field_binding() {
        let data = vec![LabelledRow { r#type: "literal".to_owned(), number: 7 }].into_sql();
        assert_eq!(data.db_type(), "LabelledRow");
        assert_eq!(data.rows()[0].columns(), &[ColumnData::String(Some(Cow::Owned("literal".to_owned()))), ColumnData::I32(Some(7))]);
    }
}
