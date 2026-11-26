use super::{iterations, scram, FIRST, NONCE};
use std::io::ErrorKind;

const SIGNATURE: &[u8] = b"v=U+ppxD5XUKtradnv8e2MkeupiA8FU87Sg8CXzXHDAzw=";

#[test]
fn zero_iterations_fail_before_salt_decode() {
    let input = String::from_utf8(iterations("0")).unwrap().replace("fs3IXBy7U7+IvVjZ", "A");
    let error = scram().update(input.as_bytes()).unwrap_err();
    assert_eq!(error.kind(), ErrorKind::InvalidInput);
    assert_eq!(error.to_string(), "invalid SCRAM iteration count");
}

#[test]
fn leading_zero_iterations_are_not_positive_number_syntax() {
    for value in ["00", "01", "04096", "0100000"] {
        let error = scram().update(&iterations(value)).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
        assert_eq!(error.to_string(), "invalid SCRAM iteration count");
    }
}

#[test]
fn positive_minimum_still_requires_a_correct_server_signature() {
    let mut client = scram();
    client.update(&iterations("1")).unwrap();
    let error = client.finish(SIGNATURE).unwrap_err();
    assert_eq!(error.to_string(), "SCRAM verification error");
}

#[test]
fn standard_server_errors_remain_authentication_failures() {
    for value in ["invalid-proof", "unknown-user", "no-resources", "other-error", "channel-bindings-dont-match"] {
        let mut client = scram();
        client.update(FIRST.as_bytes()).unwrap();
        let error = client.finish(format!("e={value}").as_bytes()).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Other);
        assert_eq!(error.to_string(), format!("SCRAM error: {value}"));
        assert_eq!(client.finish(SIGNATURE).unwrap_err().to_string(), "invalid SCRAM state");
    }
}

#[test]
fn nonempty_server_error_values_support_equals_and_utf8() {
    for value in ["custom=reason", "=", "\u{6771}\u{4eac}", "space allowed", "\u{0001}"] {
        let mut client = scram();
        client.update(FIRST.as_bytes()).unwrap();
        let error = client.finish(format!("e={value}").as_bytes()).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Other);
        assert_eq!(error.to_string(), format!("SCRAM error: {value}"));
    }
}

#[test]
fn empty_nul_comma_and_invalid_utf8_errors_are_not_valid_values() {
    for value in [b"e=".as_slice(), b"e=\0", b"e=,", b"e=bad,extra=value", b"e=bad\0value", b"e=\xff"] {
        let mut client = scram();
        client.update(FIRST.as_bytes()).unwrap();
        let error = client.finish(value).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
        assert!(!error.to_string().starts_with("SCRAM error:"));
    }
}

#[test]
fn signature_success_and_failure_are_terminal_states() {
    for signature in [SIGNATURE, b"v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".as_slice()] {
        let mut client = scram();
        client.update(FIRST.as_bytes()).unwrap();
        assert_eq!(client.finish(signature).is_ok(), signature == SIGNATURE);
        assert_eq!(client.finish(SIGNATURE).unwrap_err().to_string(), "invalid SCRAM state");
        assert_eq!(client.update(FIRST.as_bytes()).unwrap_err().to_string(), "invalid SCRAM state");
    }
}

#[test]
fn client_nonce_prefix_contract_is_preserved_without_claiming_authentication() {
    for nonce in [NONCE.to_owned(), format!("{NONCE}server")] {
        let mut client = scram();
        let first = format!("r={nonce},s=fs3IXBy7U7+IvVjZ,i=4096");
        client.update(first.as_bytes()).unwrap();
        assert!(client.finish(SIGNATURE).is_err());
    }
    for nonce in ["other", "", &NONCE[1..]] {
        let first = format!("r={nonce},s=fs3IXBy7U7+IvVjZ,i=4096");
        assert!(scram().update(first.as_bytes()).is_err());
    }
}
