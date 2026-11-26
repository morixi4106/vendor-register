#[cfg(test)]
mod tests {
    use native_tls::{Identity, Protocol};
    use std::{
        io,
        pin::Pin,
        sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc},
        task::{Context, Poll},
        time::Duration,
    };
    use tiberius::{error::Error, Client, Config, EncryptionLevel};
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf};
    use tokio_util::compat::TokioAsyncReadCompatExt;

    fn packet(kind: u8, payload: &[u8]) -> Vec<u8> {
        let length = u16::try_from(8 + payload.len()).unwrap().to_be_bytes();
        let mut bytes = vec![kind, 1, length[0], length[1], 0, 0, 1, 0];
        bytes.extend_from_slice(payload);
        bytes
    }

    async fn frame<S: AsyncRead + Unpin>(stream: &mut S) -> io::Result<(u8, Vec<u8>)> {
        let mut header = [0u8; 8];
        stream.read_exact(&mut header).await?;
        let length = u16::from_be_bytes([header[2], header[3]]) as usize;
        assert!((8..=32768).contains(&length), "bounded synthetic TDS frame");
        let mut payload = vec![0u8; length - 8];
        stream.read_exact(&mut payload).await?;
        Ok((header[0], payload))
    }

    // Force partial transport reads/writes through the actual driver's wrapper.
    struct Segmented(DuplexStream);
    impl AsyncRead for Segmented {
        fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, out: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
            let mut small = [0u8; 3];
            let count = out.remaining().min(small.len());
            let mut part = ReadBuf::new(&mut small[..count]);
            match Pin::new(&mut self.0).poll_read(cx, &mut part) {
                Poll::Ready(Ok(())) => { out.put_slice(part.filled()); Poll::Ready(Ok(())) }
                other => other,
            }
        }
    }
    impl AsyncWrite for Segmented {
        fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, bytes: &[u8]) -> Poll<io::Result<usize>> {
            Pin::new(&mut self.0).poll_write(cx, &bytes[..bytes.len().min(11)])
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.0).poll_flush(cx)
        }
        fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.0).poll_shutdown(cx)
        }
    }

    // Synthetic server framing, not a copy/replacement of the client parser.
    struct ServerFraming {
        stream: DuplexStream,
        handshake: Arc<AtomicBool>,
        received: Arc<AtomicUsize>,
        sent: Arc<AtomicUsize>,
        header: [u8; 8],
        header_pos: usize,
        remaining: usize,
        outgoing: Vec<u8>,
        pending: Vec<u8>,
        written: usize,
    }
    impl AsyncRead for ServerFraming {
        fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, out: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
            let this = self.get_mut();
            if !this.handshake.load(Ordering::SeqCst) {
                return Pin::new(&mut this.stream).poll_read(cx, out);
            }
            if out.remaining() == 0 { return Poll::Ready(Ok(())); }
            while this.header_pos < 8 {
                let mut header = ReadBuf::new(&mut this.header[this.header_pos..]);
                match Pin::new(&mut this.stream).poll_read(cx, &mut header) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                    Poll::Ready(Ok(())) => {
                        let count = header.filled().len();
                        if count == 0 { return Poll::Ready(Ok(())); }
                        this.header_pos += count;
                    }
                }
                if this.header_pos == 8 {
                    assert_eq!(this.header[0], 0x12, "client TLS must use PRELOGIN frames");
                    let length = u16::from_be_bytes([this.header[2], this.header[3]]) as usize;
                    assert!((9..=32768).contains(&length));
                    this.remaining = length - 8;
                    this.received.fetch_add(1, Ordering::SeqCst);
                }
            }
            let count = out.remaining().min(this.remaining);
            let mut bytes = vec![0u8; count];
            let mut payload = ReadBuf::new(&mut bytes);
            match Pin::new(&mut this.stream).poll_read(cx, &mut payload) {
                Poll::Ready(Ok(())) => {
                    let read = payload.filled().len();
                    out.put_slice(payload.filled());
                    this.remaining -= read;
                    if this.remaining == 0 { this.header_pos = 0; }
                    Poll::Ready(Ok(()))
                }
                other => other,
            }
        }
    }
    impl AsyncWrite for ServerFraming {
        fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, bytes: &[u8]) -> Poll<io::Result<usize>> {
            let this = self.get_mut();
            if !this.handshake.load(Ordering::SeqCst) {
                return Pin::new(&mut this.stream).poll_write(cx, bytes);
            }
            assert!(this.outgoing.len() + bytes.len() <= 32760);
            this.outgoing.extend_from_slice(bytes);
            Poll::Ready(Ok(bytes.len()))
        }
        fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            let this = self.get_mut();
            if this.pending.is_empty() && !this.outgoing.is_empty() {
                this.pending = packet(0x12, &std::mem::take(&mut this.outgoing));
                this.written = 0;
                this.sent.fetch_add(1, Ordering::SeqCst);
            }
            while this.written < this.pending.len() {
                match Pin::new(&mut this.stream).poll_write(cx, &this.pending[this.written..]) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                    Poll::Ready(Ok(0)) => return Poll::Ready(Err(io::ErrorKind::WriteZero.into())),
                    Poll::Ready(Ok(count)) => this.written += count,
                }
            }
            this.pending.clear();
            Pin::new(&mut this.stream).poll_flush(cx)
        }
        fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.stream).poll_shutdown(cx)
        }
    }

    fn assert_certificate_error(name: &str, message: &str) {
        let message = message.to_lowercase();
        let matches = if cfg!(windows) {
            let code = match name {
                "untrusted" => -2146762487i32,
                "hostname" => -2146762481i32,
                "expired" | "future" => -2146762495i32,
                _ => panic!("unbound certificate scenario"),
            };
            message.ends_with(&format!("(os error {code})"))
        } else {
            let expected: &[&str] = match name {
                "untrusted" => &["self-signed", "unable to get local issuer"],
                "hostname" => &["hostname mismatch"],
                "expired" => &["certificate has expired"],
                "future" => &["certificate is not yet valid"],
                _ => panic!("unbound certificate scenario"),
            };
            expected.iter().any(|part| message.contains(part))
        };
        assert!(matches, "unexpected certificate error for {name}: {message}");
    }

    async fn probe(name: &str, identity: &[u8], trust: bool, host: &str) {
        for mode in [EncryptionLevel::On, EncryptionLevel::Required] {
            for server_mode in [1u8, 3u8] {
                let (client_io, mut server_io) = tokio::io::duplex(65536);
                let handshake = Arc::new(AtomicBool::new(true));
                let received = Arc::new(AtomicUsize::new(0));
                let sent = Arc::new(AtomicUsize::new(0));
                let mut builder = native_tls::TlsAcceptor::builder(Identity::from_pkcs12(identity, "synthetic-fixture-only").unwrap());
                builder.min_protocol_version(Some(Protocol::Tlsv12));
                builder.max_protocol_version(Some(Protocol::Tlsv12));
                let acceptor = tokio_native_tls::TlsAcceptor::from(builder.build().unwrap());
                let mut config = Config::new();
                config.host(host);
                config.encryption(mode);
                if trust { config.trust_cert_ca_bundle(include_bytes!("../certificates/root.der").to_vec()); }
                let server = async {
                    let (kind, _) = frame(&mut server_io).await.unwrap();
                    assert_eq!(kind, 0x12, "one plaintext PRELOGIN precedes TLS");
                    server_io.write_all(&packet(4, &[1, 0, 6, 0, 1, 255, server_mode])).await.unwrap();
                    server_io.flush().await.unwrap();
                    let framed = ServerFraming {stream:server_io,handshake:handshake.clone(),received:received.clone(),sent:sent.clone(),header:[0;8],header_pos:0,remaining:0,outgoing:Vec::new(),pending:Vec::new(),written:0};
                    let mut tls = match acceptor.accept(framed).await {
                        Ok(tls) => tls,
                        Err(_) => return 0,
                    };
                    tls.flush().await.unwrap();
                    handshake.store(false, Ordering::SeqCst);
                    let (kind, _) = match frame(&mut tls).await {
                        Ok(frame) => frame,
                        Err(_) => return 0,
                    };
                    assert_eq!(kind, 0x10, "LOGIN must be encrypted after removing PRELOGIN wrapping");
                    tls.write_all(&packet(4, &[0xfd, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).await.unwrap();
                    tls.flush().await.unwrap();
                    1
                };
                let client = async { Client::connect(config, Segmented(client_io).compat()).await.map(|_| ()) };
                let (result, login) = tokio::time::timeout(Duration::from_secs(10), async {tokio::join!(client,server)}).await.expect("bounded classic memory TLS handshake");
                assert!(received.load(Ordering::SeqCst) > 0);
                assert!(sent.load(Ordering::SeqCst) > 0);
                if name == "trusted" {
                    result.unwrap();
                    assert_eq!(login, 1);
                } else {
                    match result {
                        Err(Error::Tls(message)) => {
                            assert_certificate_error(name, &message);
                            eprintln!("OJA_TDS_CLASSIC_ERROR scenario={name} client={mode:?} server={server_mode} detail={message}");
                        }
                        other => panic!("expected certificate error, got {other:?}"),
                    }
                    assert_eq!(login, 0, "no encrypted LOGIN on rejected identity");
                }
                eprintln!("OJA_TDS_CLASSIC scenario={name} client={mode:?} server={server_mode} success={} clear_prelogin=1 encrypted_login={login} received={} sent={}",name == "trusted",received.load(Ordering::SeqCst),sent.load(Ordering::SeqCst));
            }
        }
    }

    #[tokio::test]
    async fn trusted_classic_modes_complete_encrypted_login() {
        probe("trusted", include_bytes!("../certificates/valid.pfx"), true, "tds.fixture.invalid").await;
    }
    #[tokio::test]
    async fn untrusted_classic_modes_reject_before_login() {
        probe("untrusted", include_bytes!("../certificates/valid.pfx"), false, "tds.fixture.invalid").await;
    }
    #[tokio::test]
    async fn wrong_hostname_classic_modes_reject_before_login() {
        probe("hostname", include_bytes!("../certificates/valid.pfx"), true, "wrong.fixture.invalid").await;
    }
    #[tokio::test]
    async fn expired_classic_modes_reject_before_login() {
        probe("expired", include_bytes!("../certificates/expired.pfx"), true, "tds.fixture.invalid").await;
    }
    #[tokio::test]
    async fn future_classic_modes_reject_before_login() {
        probe("future", include_bytes!("../certificates/future.pfx"), true, "tds.fixture.invalid").await;
    }
}
