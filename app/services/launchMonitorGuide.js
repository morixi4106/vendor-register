const CHECK_ACTIONS = {
  database_connection: {
    title: "Renderとデータベースを確認",
    detail: "WebサービスとPostgreSQLの稼働状態、接続設定、直近のデプロイログを確認します。",
    href: "/app/production-readiness",
  },
  render_http_5xx: {
    title: "Renderのエラーログを確認",
    detail: "発生時刻付近の5xxと例外を確認し、決済・返金・撤回処理への影響を切り分けます。",
    href: "/app/production-readiness",
  },
  render_app_errors: {
    title: "アプリ例外を確認",
    detail: "Renderのアプリログで最初の例外を確認し、同じ操作を繰り返す前に原因を特定します。",
    href: "/app/production-readiness",
  },
  render_log_collection: {
    title: "監視のRender接続を確認",
    detail: "Render APIキー、対象サービス、ログ取得権限を確認します。",
    href: "/app/production-readiness",
  },
  render_auth_rejections: {
    title: "認証拒否の増加を確認",
    detail: "不正アクセスか設定変更の影響かをRenderログで確認します。",
    href: "/app/production-readiness",
  },
  render_rate_limits: {
    title: "アクセス制限の原因を確認",
    detail: "問い合わせ連投や外部連携の再試行が増えていないか確認します。",
    href: "/app/contact-inquiries",
  },
  withdrawal_operations_available: {
    title: "撤回運用データを確認",
    detail: "撤回申請一覧が開けるか確認し、データベースやmigrationの状態を調べます。",
    href: "/app/withdrawals",
  },
  withdrawal_email_outbox: {
    title: "撤回メールキューを確認",
    detail: "失敗・滞留メールの理由を確認します。監視画面から業務メールを自動再送はしません。",
    href: "/app/withdrawals",
  },
  withdrawal_email_worker_heartbeat: {
    title: "撤回メールワーカーを確認",
    detail: "Renderの定期実行とワーカートークンを確認し、最後の成功時刻を照合します。",
    href: "/app/production-readiness",
  },
  withdrawal_processing_integrity: {
    title: "撤回申請の処理漏れを確認",
    detail: "返送案内、店舗通知、返金判断、完了通知の不足項目を申請ごとに確認します。",
    href: "/app/withdrawals",
  },
  seller_order_unresolved_shadow_checks: {
    title: "SellerOrder差分を確認",
    detail: "既存台帳と出店者別注文の差分を確認し、原因が分かるまで読替え範囲を広げません。",
    href: "/app/seller-order-shadow",
  },
  seller_ledger_repair_candidates: {
    title: "売上台帳の補正候補を確認",
    detail: "注文・返金・補正履歴を照合してから、管理画面の補正機能を使用します。",
    href: "/app/sellers",
  },
  test_store_pending_payout_runs: {
    title: "テスト店舗の出金予定を止める",
    detail: "テスト店舗の出金予定が実行対象に残っていないか確認します。",
    href: "/app/payout-runs",
  },
  contact_inquiry_spike: {
    title: "問い合わせ急増を確認",
    detail: "同一内容の連投、送信元の偏り、メール送信失敗を確認します。",
    href: "/app/contact-inquiries",
  },
  public_root_redirect: {
    title: "アプリ公開URLの遷移を確認",
    detail: "アプリのルートが正式ストアへ正しく転送されるか確認します。",
    href: "/app/production-readiness",
  },
  official_storefront: {
    title: "正式ストアの公開状態を確認",
    detail: "パスワードページへ戻っていないか、ブランド表示と購入導線が開いているか確認します。",
    href: "/app/production-readiness",
  },
  heavy_checks_not_initialized: {
    title: "重い整合性検査の初回実行を待つ",
    detail: "次の実行で台帳とSellerOrderを検査します。15分以上続く場合は監視実行履歴を確認します。",
    href: "/app/production-readiness",
  },
  launch_integrity: {
    title: "業務データ整合性検査を確認",
    detail: "検査自体が失敗しています。RenderログとDB接続を確認し、次の5分後の再試行結果を待ちます。",
    href: "/app/production-readiness",
  },
};

export function buildLaunchMonitorGuide({ enabled = false, metadata = {} } = {}) {
  const report = asObject(metadata.lastReport);
  const checks = Array.isArray(report.checks) ? report.checks : [];

  if (metadata.completedAt) {
    return {
      tone: "healthy",
      title: "72時間の監視は完了しています",
      description: "重大な未解決項目がないことを本番確認で最終確認してください。",
      steps: [productionReadinessStep()],
    };
  }

  if (!enabled) {
    return {
      tone: "waiting",
      title: "監視はまだ開始していません",
      description: "公開準備を終えてから監視を有効にします。現在は業務データを変更しません。",
      steps: [
        productionReadinessStep(),
        {
          id: "open-storefront",
          title: "ストアのパスワードを解除して表示を確認",
          detail: "シークレットウィンドウとスマートフォンで商品、カート、決済入口を確認します。",
        },
        {
          id: "activate-monitor",
          title: "公開直後に監視を開始",
          detail: "パスワード解除後にCodexへ監視開始を依頼してください。開始時刻を更新して72時間を新規に計測します。",
        },
      ],
    };
  }

  if (!metadata.lastCheckedAt || checks.length === 0) {
    return {
      tone: "waiting",
      title: "初回の監視結果を待っています",
      description: "5分以上結果が出ない場合はGitHub ActionsとRender Cronの実行状態を確認します。",
      steps: [productionReadinessStep()],
    };
  }

  const issues = checks
    .filter((check) => check.severity === "critical" || check.severity === "warning")
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity));

  if (issues.length === 0) {
    return {
      tone: "healthy",
      title: "現在、対応が必要な項目はありません",
      description: "監視を継続します。決済・返金・出金に違和感があれば本番確認と各管理画面を確認してください。",
      steps: [],
    };
  }

  return {
    tone: issues.some((check) => check.severity === "critical")
      ? "critical"
      : "warning",
    title: issues.some((check) => check.severity === "critical")
      ? "重大な異常を先に確認してください"
      : "注意項目を順に確認してください",
    description: "監視は原因候補と確認先を示すだけで、返金・出金・台帳補正を自動実行しません。",
    steps: uniqueIssueSteps(issues),
  };
}

function uniqueIssueSteps(issues) {
  const seen = new Set();
  return issues.flatMap((check) => {
    if (seen.has(check.id)) return [];
    seen.add(check.id);
    const action = CHECK_ACTIONS[check.id] || productionReadinessStep();
    return [{ ...action, id: check.id, severity: check.severity }];
  });
}

function productionReadinessStep() {
  return {
    id: "production-readiness",
    title: "本番確認の警告を確認",
    detail: "決済、出金、配送、撤回運用、Shopify権限の未完了項目を確認します。",
    href: "/app/production-readiness",
  };
}

function severityRank(value) {
  return value === "critical" ? 2 : value === "warning" ? 1 : 0;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
