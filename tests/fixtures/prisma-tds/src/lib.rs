#[cfg(test)]
mod tests {
    use futures_util::io::{AsyncRead, AsyncWrite};
    use std::{
        io::{self, Cursor, Read},
        pin::Pin,
        sync::{Arc, Mutex},
        task::{Context, Poll},
        time::Duration,
    };
    use tiberius::{Client, Config, EncryptionLevel, Error};

    // A memory-only TDS peer: no sockets, DNS, credentials, or external DB.
    struct Peer {
        input: Cursor<Vec<u8>>,
        writes: Arc<Mutex<Vec<u8>>>,
    }

    impl AsyncRead for Peer {
        fn poll_read(mut self: Pin<&mut Self>, _: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
            Poll::Ready(self.input.read(buf))
        }
    }

    impl AsyncWrite for Peer {
        fn poll_write(self: Pin<&mut Self>, _: &mut Context<'_>, bytes: &[u8]) -> Poll<io::Result<usize>> {
            let mut writes = self.writes.lock().unwrap();
            if writes.len() + bytes.len() > 32768 {
                return Poll::Ready(Err(io::Error::other("synthetic peer write bound")));
            }
            writes.extend_from_slice(bytes);
            Poll::Ready(Ok(bytes.len()))
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> { Poll::Ready(Ok(())) }
        fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> { Poll::Ready(Ok(())) }
    }

    fn packet(payload: &[u8]) -> Vec<u8> {
        let length = u16::try_from(8 + payload.len()).unwrap().to_be_bytes();
        let mut bytes = vec![4, 1, length[0], length[1], 0, 0, 1, 0];
        bytes.extend_from_slice(payload);
        bytes
    }

    fn prelogin(encryption: u8) -> Vec<u8> { packet(&[1, 0, 6, 0, 1, 255, encryption]) }
    fn done() -> Vec<u8> { packet(&[0xfd, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }

    async fn connect(bytes: Vec<u8>, level: EncryptionLevel) -> (Result<(), Error>, Vec<u8>) {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let peer = Peer { input: Cursor::new(bytes), writes: writes.clone() };
        let mut config = Config::new();
        config.encryption(level);
        let outcome = tokio::time::timeout(Duration::from_secs(2), Client::connect(config, peer)).await.expect("bounded connect");
        let result = outcome.map(|_| ());
        let written = writes.lock().unwrap().clone();
        eprintln!("OJA_TDS_CALL success={}", result.is_ok());
        (result, written)
    }

    fn written_types(bytes: &[u8]) -> Vec<u8> {
        let mut types = Vec::new();
        let mut offset = 0;
        while offset < bytes.len() {
            assert!(offset + 8 <= bytes.len());
            let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
            assert!(length >= 8 && offset + length <= bytes.len());
            types.push(bytes[offset]);
            offset += length;
        }
        types
    }

    async fn login_error(payload: &[u8], expected: &str) {
        let mut input = prelogin(0);
        input.extend(packet(payload));
        let (outcome, writes) = connect(input, EncryptionLevel::Off).await;
        match outcome {
            Err(Error::Protocol(message)) => assert!(message.contains(expected), "{message}"),
            other => panic!("expected protocol error, got {other:?}"),
        }
        assert_eq!(written_types(&writes), [0x12, 0x10]);
    }

    #[tokio::test]
    async fn normal_prelogin_and_done_reach_connected_state() {
        let mut input = prelogin(0); input.extend(done());
        let (result, writes) = connect(input, EncryptionLevel::Off).await;
        result.unwrap();
        assert_eq!(written_types(&writes), [0x12, 0x10]);
    }

    #[tokio::test]
    async fn required_tls_rejects_off_before_login() {
        let (result, writes) = connect(prelogin(0), EncryptionLevel::Required).await;
        assert!(matches!(result, Err(Error::Protocol(_))));
        assert_eq!(written_types(&writes), [0x12]);
    }

    #[tokio::test]
    async fn on_tls_rejects_not_supported_before_login() {
        let (result, writes) = connect(prelogin(2), EncryptionLevel::On).await;
        assert!(matches!(result, Err(Error::Protocol(_))));
        assert_eq!(written_types(&writes), [0x12]);
    }

    #[tokio::test]
    async fn required_tls_rejects_not_supported_before_login() {
        let (result, writes) = connect(prelogin(2), EncryptionLevel::Required).await;
        assert!(matches!(result, Err(Error::Protocol(_))));
        assert_eq!(written_types(&writes), [0x12]);
    }

    #[tokio::test]
    async fn on_tls_rejects_off_before_login() {
        let (result, writes) = connect(prelogin(0), EncryptionLevel::On).await;
        assert!(matches!(result, Err(Error::Protocol(_))));
        assert_eq!(written_types(&writes), [0x12]);
    }

    #[tokio::test]
    async fn malformed_threadid_is_protocol_error_before_login() {
        let (result, writes) = connect(packet(&[3, 0, 6, 0, 2, 255, 0, 0]), EncryptionLevel::Off).await;
        assert!(matches!(result, Err(Error::Protocol(_))));
        assert_eq!(written_types(&writes), [0x12]);
    }

    #[tokio::test]
    async fn row_without_metadata_is_rejected() { login_error(&[0xd1], "metadata").await; }

    #[tokio::test]
    async fn nbcrow_without_metadata_is_rejected() { login_error(&[0xd2], "metadata").await; }

    #[tokio::test]
    async fn feature_ack_rejects_unknown_feature() { login_error(&[0xae, 1], "unsupported feature").await; }

    #[tokio::test]
    async fn feature_ack_rejects_invalid_fedauth_length() { login_error(&[0xae, 2, 1, 0, 0, 0], "data length").await; }

    #[tokio::test]
    async fn colinfo_is_handled_without_unimplemented_panic() {
        let mut input = prelogin(0); input.extend(packet(&[0xa5, 0, 0])); input.extend(done());
        let (result, writes) = connect(input, EncryptionLevel::Off).await;
        result.unwrap();
        assert_eq!(written_types(&writes), [0x12, 0x10]);
    }

    #[tokio::test]
    async fn unknown_prelogin_option_is_forward_compatible() {
        for token in 8..255 {
            let mut input = packet(&[token, 0, 11, 0, 0, 1, 0, 11, 0, 1, 255, 0]);
            input.extend(done());
            let (result, writes) = connect(input, EncryptionLevel::Off).await;
            result.unwrap();
            assert_eq!(written_types(&writes), [0x12, 0x10]);
        }
    }
}
