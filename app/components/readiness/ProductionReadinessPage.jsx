import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { productionReadinessStyles } from "./ProductionReadinessPage.styles.js";
import { KomojuLimitedLaunchBaselineControl } from "./KomojuLimitedLaunchBaselineControl.jsx";
import { Metric, Status } from "./ProductionReadinessPrimitives.jsx";
import { buildProductionReadinessPageState } from "./productionReadinessPageState.js";
import { operationalEvidenceAnchor } from "./launchPreparationViewModel.js";
import { CHECKOUT_VALIDATION_LIVE_PROBE_SCENARIOS } from "../../services/checkoutValidationLiveProbe.js";
import {
  categoryLabel,
  heartbeatStatusLabel,
  paymentFlowLabel,
  sellerPayoutFlowLabel,
} from "./productionReadinessViewModel.js";

export default function ProductionReadinessPage() {
  const data = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const {
    blockingChecks,
    isCarrierSubmitting,
    isCheckoutGateSubmitting,
    isCheckoutValidationSubmitting,
    isLimitedLaunchBaselineSubmitting,
    displaySummary,
    orderedChecks,
    standardDirect,
    checkoutReplayReady,
    launchPreparation,
  } = buildProductionReadinessPageState(data, navigation);
  return (
    <div className="readiness-page">
      <style>{productionReadinessStyles}</style>
      <section className="readiness-card">
        <div className="readiness-header">
          <div>
            <h1 className="readiness-title">本番前チェック</h1>
            <p className="readiness-subtitle">
              決済、精算、Shopify権限、出店者まわりの切り替え漏れを確認します。
              秘密鍵の値は表示しません。
            </p>
          </div>
          <span
            className={`readiness-badge ${`readiness-badge--${launchPreparation.verdict.status}`}`}
          >
            {launchPreparation.verdict.label}
          </span>
        </div>
      </section>

      <section
        className="readiness-preparation"
        aria-labelledby="readiness-preparation-title"
      >
        <h2
          className="readiness-section-title"
          id="readiness-preparation-title"
        >
          公開準備の状況
        </h2>
        <dl className="readiness-preparation-grid">
          <div>
            <dt>現在の購入経路</dt>
            <dd>{launchPreparation.modeLabel}</dd>
            <dd>
              <span
                className={`readiness-status readiness-status--${launchPreparation.checkout.status}`}
              >
                {launchPreparation.checkout.label}
              </span>
            </dd>
          </div>
          <div>
            <dt>実地確認の証跡</dt>
            <dd>
              {launchPreparation.evidence.available
                ? `確認済み ${launchPreparation.evidence.confirmedCount} / 対象 ${launchPreparation.evidence.requiredCount}件`
                : "取得未確認"}
            </dd>
            <dd>
              未完了 {launchPreparation.evidence.pendingCount}件 / 国内限定例外{" "}
              {launchPreparation.evidence.acceptedCount}件
            </dd>
          </div>
          <div>
            <dt>海外販売</dt>
            <dd>
              <span
                className={`readiness-status readiness-status--${launchPreparation.international.status}`}
              >
                {launchPreparation.international.label}
              </span>
            </dd>
            <dd>{launchPreparation.international.detail}</dd>
          </div>
          <div>
            <dt>自動監視通知</dt>
            <dd>{launchPreparation.notificationLabel}</dd>
            <dd>
              <Link className="readiness-link" to="/app/launch-monitor">
                通知の確認状況
              </Link>
            </dd>
          </div>
        </dl>
        <div className="readiness-observation">
          <span>判定取得：{launchPreparation.observedAt} JST</span>
          <span>リリース：{launchPreparation.releaseId}</span>
        </div>
      </section>

      <section
        className="readiness-preparation"
        aria-labelledby="readiness-next-step-title"
      >
        <h2 className="readiness-section-title" id="readiness-next-step-title">
          次にやること
        </h2>
        <ol className="readiness-next-actions">
          {launchPreparation.nextActions.map((item) => (
            <li key={item.id}>
              <div>
                <h3>{item.title}</h3>
                <p>{item.detail}</p>
              </div>
              <Link className="readiness-link" to={item.to}>
                確認へ
              </Link>
            </li>
          ))}
        </ol>
      </section>

      <section className="readiness-card">
        <div className="readiness-tool">
          <div className="readiness-tool__body">
            <h2 className="readiness-tool__title">法務メール緊急保留</h2>
            <p className="readiness-tool__text">
              状態:{" "}
              {data.platformOperationalControl?.legalEmailHold
                ? "保留中"
                : "送信可能"}
            </p>
            <p className="readiness-tool__text">
              撤回受付・返送案内・返金などの法務メールが対象です。監視通知は別設定：
              {launchPreparation.notificationLabel}。
            </p>
          </div>
          {data.platformOperationalControl?.legalEmailHold ? (
            <Form method="post" className="readiness-inline-form">
              <input
                type="hidden"
                name="intent"
                value="release_legal_email_hold"
              />
              <input name="reason" placeholder="解除理由" required />
              <input
                name="releaseEvidenceReference"
                placeholder="文面確認・復旧の証跡"
                required
              />
              <button
                className="readiness-button"
                disabled={navigation.state !== "idle"}
                type="submit"
              >
                法務メールを段階再開
              </button>
            </Form>
          ) : (
            <Form method="post" className="readiness-inline-form">
              <input
                type="hidden"
                name="intent"
                value="activate_legal_email_hold"
              />
              <input name="reason" placeholder="保留理由" required />
              <button
                className="readiness-button readiness-button--danger"
                disabled={navigation.state !== "idle"}
                type="submit"
              >
                法務メールを保留
              </button>
            </Form>
          )}
        </div>
        {actionData?.legalEmailControl ? (
          <div
            className={`readiness-result ${
              actionData.legalEmailControl.ok ? "" : "readiness-result--error"
            }`}
          >
            {actionData.legalEmailControl.ok
              ? "法務メール統制を更新しました。"
              : `処理を完了できませんでした: ${
                  actionData.legalEmailControl.reason || "unknown"
                }`}
          </div>
        ) : null}
      </section>

      <section className="readiness-card">
        <div className="readiness-tool">
          <div className="readiness-tool__body">
            <h2 className="readiness-tool__title">自動メール緊急停止</h2>
            <p className="readiness-tool__text">
              状態:{" "}
              {data.platformOperationalControl?.automatedEmailHold
                ? "停止中"
                : "送信可能"}
            </p>
            <p className="readiness-tool__text">
              対象は販促・AI・補助的な自動通知です。ログインコード・法務・注文メールは別制御です。監視通知：
              {launchPreparation.notificationLabel}。
            </p>
          </div>
          {data.platformOperationalControl?.automatedEmailHold ? (
            <Form method="post" className="readiness-inline-form">
              <input
                type="hidden"
                name="intent"
                value="release_automated_email_hold"
              />
              <input name="reason" placeholder="解除理由" required />
              <input
                name="releaseEvidenceReference"
                placeholder="復旧確認の証拠"
                required
              />
              <button
                className="readiness-button"
                disabled={navigation.state !== "idle"}
                type="submit"
              >
                自動メールを再開
              </button>
            </Form>
          ) : (
            <Form method="post" className="readiness-inline-form">
              <input
                type="hidden"
                name="intent"
                value="activate_automated_email_hold"
              />
              <input name="reason" placeholder="停止理由" required />
              <button
                className="readiness-button readiness-button--danger"
                disabled={navigation.state !== "idle"}
                type="submit"
              >
                自動メールを停止
              </button>
            </Form>
          )}
        </div>
        {actionData?.automatedEmailControl ? (
          <div
            className={`readiness-result ${
              actionData.automatedEmailControl.ok
                ? ""
                : "readiness-result--error"
            }`}
          >
            {actionData.automatedEmailControl.ok
              ? "自動メール統制を更新しました。"
              : `処理を完了できませんでした: ${
                  actionData.automatedEmailControl.reason || "unknown"
                }`}
          </div>
        ) : null}
      </section>

      <section className="readiness-card" id="operational-evidence">
        <h2 className="readiness-section-title">実地確認の証跡</h2>
        <p className="readiness-subtitle">
          未確認 {launchPreparation.evidence.pendingCount}件、うち国内限定例外{" "}
          {launchPreparation.evidence.acceptedCount}
          件。例外は実確認済みではなく、海外販売の確認には流用できません。
        </p>
        <div className="readiness-table-wrap">
          <table className="readiness-table">
            <thead>
              <tr>
                <th>確認項目</th>
                <th>現在</th>
                <th>証跡を更新</th>
              </tr>
            </thead>
            <tbody>
              {(data.operationalReadiness?.rows || [])
                .filter((row) => row.definition.supplemental !== true)
                .map((row) => (
                  <tr
                    key={row.definition.key}
                    id={operationalEvidenceAnchor(row.definition.key)}
                  >
                    <td>
                      <strong>{row.definition.label}</strong>
                      <div>有効期間 {row.definition.validityDays}日</div>
                      {row.definition.key ===
                      "CHECKOUT_VALIDATION_REPLAY_COMPLETED" ? (
                        <div>
                          開発ストアで許可ケースと遮断ケースを実行し、Shopify
                          CLIのFunctionログまたは再生結果を証跡として登録します。
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <span
                        className={`readiness-status readiness-status--${launchPreparation.evidenceByKey[row.definition.key]?.status || "manual"}`}
                      >
                        {launchPreparation.evidenceByKey[row.definition.key]
                          ?.label || "取得未確認"}
                      </span>
                      <p className="readiness-evidence-reason">
                        {
                          launchPreparation.evidenceByKey[row.definition.key]
                            ?.reason
                        }
                      </p>
                      {launchPreparation.evidenceByKey[row.definition.key]
                        ?.expiresAt ? (
                        <div>
                          期限：
                          {
                            launchPreparation.evidenceByKey[row.definition.key]
                              .expiresAt
                          }{" "}
                          JST
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {row.definition.key ===
                      "SHOPIFY_PAYMENTS_PAYOUT_CONFIRMED" ? (
                        <div className="readiness-inline-form">
                          <p>
                            Payout
                            ID・金額・通貨・送金日・銀行着金日・証拠ファイルのSHA-256を登録し、承認してください。
                          </p>
                          <Link
                            className="readiness-button"
                            to="/app/shopify-payout-evidence"
                          >
                            Shopify着金証拠を確認
                          </Link>
                        </div>
                      ) : row.definition.automated ? (
                        <div className="readiness-inline-form">
                          <p>
                            {row.definition.key ===
                            "PLATFORM_DIRECT_PAYMENT_FLOW_VERIFIED"
                              ? "KOMOJU本番カード1件について、Shopify注文、PaymentAttempt、SellerOrder、Shadow、売上台帳が一致した場合だけ記録されます。"
                              : "この項目は、実注文と全額返金の自動照合が完了した場合だけ記録されます。"}
                          </p>
                          <Link
                            className="readiness-button"
                            to="/app/production-transaction-probe"
                          >
                            {row.definition.key ===
                            "PLATFORM_DIRECT_PAYMENT_FLOW_VERIFIED"
                              ? "本番決済1件を確認"
                              : "本番注文・返金 E2E を確認"}
                          </Link>
                        </div>
                      ) : (
                        <Form method="post" className="readiness-inline-form">
                          <input
                            type="hidden"
                            name="intent"
                            value="record_operational_attestation"
                          />
                          <input
                            type="hidden"
                            name="checkKey"
                            value={row.definition.key}
                          />
                          <input
                            type="hidden"
                            name="status"
                            value="CONFIRMED"
                          />
                          <input
                            aria-label={`${row.definition.label}の証跡参照`}
                            name="evidenceReference"
                            placeholder="チケット番号、保存先URL、確認記録"
                            required
                          />
                          <input
                            aria-label={`${row.definition.label}のSHA-256`}
                            name="evidenceHash"
                            placeholder="SHA-256（任意）"
                          />
                          <input
                            aria-label={`${row.definition.label}のメモ`}
                            name="notes"
                            placeholder="確認内容"
                          />
                          {row.definition.key ===
                          "CHECKOUT_VALIDATION_LIVE_PROBE_COMPLETED" ? (
                            <fieldset className="readiness-release-manifest">
                              <legend>
                                現在のリリースと実チェックアウト結果
                              </legend>
                              {[
                                ["releaseId", "Release ID"],
                                ["renderCommit", "Render commit"],
                                ["migrationVersion", "Migration"],
                                ["shopifyAppVersion", "Shopify app version"],
                                ["shopDomain", "Shop domain"],
                                ["functionHandle", "Function handle"],
                                ["functionUid", "Function UID"],
                                ["functionId", "Shopify Function ID"],
                                ["functionApiVersion", "Function API version"],
                                ["validationId", "Validation ID"],
                                ["policyVersion", "Policy version"],
                                [
                                  "projectionSchemaVersion",
                                  "Projection schema version",
                                ],
                              ].map(([name, label]) => (
                                <label key={name}>
                                  <span>{label}</span>
                                  <input
                                    name={name}
                                    defaultValue={
                                      data.productionRelease?.expected?.[
                                        name
                                      ] || ""
                                    }
                                    required
                                  />
                                </label>
                              ))}
                              <input
                                type="hidden"
                                name="liveProbeChallenge"
                                value={data.liveProbeChallenge?.token || ""}
                                required
                              />
                              {CHECKOUT_VALIDATION_LIVE_PROBE_SCENARIOS.map(
                                ({ id: name, label, expectedResult }) => (
                                  <div
                                    key={name}
                                    className="readiness-probe-row"
                                  >
                                    <label>
                                      <input
                                        name={`${name}Passed`}
                                        type="checkbox"
                                        required
                                      />
                                      <span>{label}</span>
                                    </label>
                                    <input
                                      name={`${name}ObservedAt`}
                                      type="datetime-local"
                                      aria-label={`${label}の実行日時`}
                                      required
                                    />
                                    <input
                                      name={`${name}ProjectionRevision`}
                                      placeholder="対象商品のProjection revision"
                                      aria-label={`${label}のProjection revision`}
                                      required
                                    />
                                    <input
                                      name={`${name}ActualResult`}
                                      placeholder={`実際の結果（${expectedResult}）`}
                                      aria-label={`${label}の実際の結果`}
                                      pattern={expectedResult}
                                      required
                                    />
                                    <input
                                      name={`${name}EvidenceReference`}
                                      placeholder="このシナリオの証跡URL・実行ID"
                                      aria-label={`${label}の証跡参照`}
                                      required
                                    />
                                    <input
                                      name={`${name}EvidenceHash`}
                                      placeholder="証跡SHA-256（64桁）"
                                      aria-label={`${label}の証跡SHA-256`}
                                      minLength={64}
                                      maxLength={64}
                                      pattern="[A-Fa-f0-9]{64}"
                                      required
                                    />
                                  </div>
                                ),
                              )}
                            </fieldset>
                          ) : null}
                          <button
                            className="readiness-button"
                            disabled={navigation.state !== "idle"}
                            type="submit"
                          >
                            確認を記録
                          </button>
                        </Form>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {actionData?.operationalAttestation ? (
          <div
            className={`readiness-result ${
              actionData.operationalAttestation.ok
                ? ""
                : "readiness-result--error"
            }`}
          >
            {actionData.operationalAttestation.ok
              ? "実地確認の証跡を更新しました。"
              : `保存できませんでした: ${
                  actionData.operationalAttestation.reason || "unknown"
                }`}
          </div>
        ) : null}
      </section>

      <section className="readiness-card">
        <div className="readiness-tool">
          <div className="readiness-tool__body">
            <h2 className="readiness-tool__title">販売緊急停止</h2>
            <p className="readiness-tool__text">
              状態:{" "}
              {data.platformOperationalControl?.checkoutHold
                ? "停止中"
                : "販売可能"}
            </p>
            <p className="readiness-tool__text">
              Shopify側の購入拒否を先に有効化し、運営直販商品を全販売チャネルから外します。復旧時は現在の適格性を再審査し、停止前に公開されていた適格商品のみ戻します。
            </p>
          </div>
          {data.platformOperationalControl?.checkoutHold ? (
            <Form method="post" className="readiness-inline-form">
              <input
                type="hidden"
                name="intent"
                value="release_emergency_checkout_hold"
              />
              <input name="reason" placeholder="解除理由" required />
              <input
                name="releaseEvidenceReference"
                placeholder="復旧確認の証跡"
                required
              />
              <button
                className="readiness-button"
                disabled={navigation.state !== "idle"}
                type="submit"
              >
                停止を解除
              </button>
            </Form>
          ) : (
            <Form method="post" className="readiness-inline-form">
              <input
                type="hidden"
                name="intent"
                value="activate_emergency_checkout_hold"
              />
              <input name="reason" placeholder="停止理由" required />
              <button
                className="readiness-button readiness-button--danger"
                disabled={navigation.state !== "idle"}
                type="submit"
              >
                全商品の販売を停止
              </button>
            </Form>
          )}
        </div>
        {actionData?.operationalControl ? (
          <div
            className={`readiness-result ${
              actionData.operationalControl.ok ? "" : "readiness-result--error"
            }`}
          >
            {actionData.operationalControl.ok
              ? "販売統制を更新しました。"
              : `処理を完了できませんでした。停止状態は維持されます: ${
                  actionData.operationalControl.reason || "unknown"
                }`}
          </div>
        ) : null}
      </section>

      <section className="readiness-card" id="checkout-validation-control">
        <div className="readiness-tool">
          <div className="readiness-tool__body">
            <h2 className="readiness-tool__title">
              Shopifyサーバー側の購入制御
            </h2>
            <p className="readiness-tool__text">
              状態: {data.checkoutValidation?.active ? "有効" : "無効"}
            </p>
            <p className="readiness-tool__text">
              {standardDirect
                ? "現在は国内運営直販の標準チェックアウト設定です。海外販売は別途、販売国・配送経路と購入制御の適合確認が必要です。"
                : "Shopify標準チェックアウト、Shop Payなどを含む購入処理をShopify Functionsで検証します。制御関数の実行失敗時も購入を拒否します。"}
            </p>
          </div>
          {standardDirect ? (
            <div className="readiness-inline-form">
              {data.checkoutValidation?.active ? (
                <Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value="disable_checkout_validation_for_standard_direct"
                  />
                  <button
                    className="readiness-button"
                    type="submit"
                    disabled={isCheckoutValidationSubmitting}
                  >
                    標準チェックアウトへ切り替える
                  </button>
                </Form>
              ) : (
                <strong>{launchPreparation.checkout.label}</strong>
              )}
            </div>
          ) : (
            <div className="readiness-inline-form">
              <KomojuLimitedLaunchBaselineControl
                actionResult={actionData?.komojuLimitedLaunchBaseline}
                isSubmitting={isLimitedLaunchBaselineSubmitting}
              />
              <Form method="post">
                <input
                  type="hidden"
                  name="intent"
                  value="stage_checkout_validation"
                />
                <button
                  className="readiness-button"
                  type="submit"
                  disabled={isCheckoutValidationSubmitting}
                >
                  無効状態で準備
                </button>
              </Form>
              <Form method="post">
                <input
                  type="hidden"
                  name="intent"
                  value="activate_checkout_validation"
                />
                <button
                  className="readiness-button"
                  type="submit"
                  disabled={
                    isCheckoutValidationSubmitting || !checkoutReplayReady
                  }
                  title={
                    checkoutReplayReady
                      ? "購入制御を有効化します"
                      : "先にFunction再生確認の証跡を記録してください"
                  }
                >
                  {isCheckoutValidationSubmitting
                    ? "購入制御を確認中"
                    : checkoutReplayReady
                      ? "再生証跡を確認して有効化"
                      : "再生証跡の記録後に有効化"}
                </button>
              </Form>
            </div>
          )}
        </div>
        {!standardDirect &&
        !data.checkoutValidation?.active &&
        !checkoutReplayReady ? (
          <p className="readiness-tool__text">
            有効化前に「購入制御Functionの開発ストア再生・遮断確認」を記録してください。本番の必須シナリオは有効化後に実施します。
          </p>
        ) : null}
        {actionData?.checkoutValidation ? (
          <div
            className={`readiness-result ${
              actionData.checkoutValidation.ok &&
              actionData.checkoutValidation.active
                ? ""
                : "readiness-result--error"
            }`}
          >
            {standardDirect && actionData.checkoutValidation.ok
              ? "Shopify標準チェックアウトへ切り替えました。"
              : actionData.checkoutValidation.ok &&
                  actionData.checkoutValidation.active
                ? "Shopifyサーバー側の購入制御を有効化しました。"
                : actionData.checkoutValidation.ok &&
                    actionData.checkoutValidation.staged
                  ? "購入制御を無効状態で準備しました。開発ストアのFunction再生と正常・遮断確認を記録してから有効化してください。"
                  : `購入制御を有効化できませんでした: ${
                      actionData.checkoutValidation.reason || "unknown"
                    }`}
          </div>
        ) : null}
      </section>

      <section className="readiness-card">
        <div className="readiness-tool">
          <div className="readiness-tool__body">
            <h2 className="readiness-tool__title">第三者商品の公開境界</h2>
            <p className="readiness-tool__text">
              運営直販商品だけをOnline
              Storeへ公開し、店舗別精算が必要な商品はApp ProxyとDraft
              Orderの購入導線に限定します。
            </p>
            <p className="readiness-tool__text">
              状態: {data.checkoutGate?.active ? "有効" : "無効"}
              {!data.checkoutGate?.available && data.checkoutGate?.message
                ? ` / ${data.checkoutGate.message}`
                : ""}
            </p>
          </div>
          <Form method="post">
            <input type="hidden" name="intent" value="activate_checkout_gate" />
            <button
              className="readiness-button"
              type="submit"
              disabled={isCheckoutGateSubmitting}
            >
              {isCheckoutGateSubmitting
                ? "商品同期・公開境界を確認中"
                : "商品同期と公開境界を適用"}
            </button>
          </Form>
        </div>
        {actionData?.checkoutGate ? (
          <div
            className={`readiness-result ${
              actionData.checkoutGate.ok ? "" : "readiness-result--error"
            }`}
          >
            {actionData.checkoutGate.ok
              ? `公開境界を適用しました。更新: ${
                  actionData.checkoutGate.result?.backfill?.changedCount ?? 0
                }件`
              : actionData.checkoutGate.message ||
                "公開境界の適用に失敗しました。"}
          </div>
        ) : null}
      </section>

      <section className="readiness-card">
        <div className="readiness-tool">
          <div className="readiness-tool__body">
            <h2 className="readiness-tool__title">配送サービス再登録</h2>
            <p className="readiness-tool__text">
              アプリを再インストールした後は、Shopify側の配送サービス登録が外れることがあります。
              配送方法にShipping V2が出ない場合はここから再登録します。
            </p>
          </div>
          <Form method="post">
            <input type="hidden" name="intent" value="register_carrier" />
            <button
              className="readiness-button"
              type="submit"
              disabled={isCarrierSubmitting}
            >
              {isCarrierSubmitting ? "再登録中" : "Shipping V2を再登録"}
            </button>
          </Form>
        </div>
        {actionData?.carrierService ? (
          <div
            className={`readiness-result ${
              actionData.carrierService.ok ? "" : "readiness-result--error"
            }`}
          >
            {actionData.carrierService.ok
              ? `登録しました。Callback: ${actionData.carrierService.callbackUrl}`
              : actionData.carrierService.message || "再登録に失敗しました。"}
          </div>
        ) : null}
      </section>

      <section className="readiness-card">
        <div className="readiness-grid">
          <Metric
            label="決済"
            value={paymentFlowLabel(data.operation)}
            compact
          />
          <Metric
            label="出店者精算"
            value={sellerPayoutFlowLabel(data.operation)}
            compact
          />
          <Metric
            label="Stripe Connect"
            value={
              data.operation?.stripeConnectProductionEnabled
                ? "使用中"
                : "使わない"
            }
            compact
          />
          <Metric
            label="公開ブロッカー"
            value={displaySummary.releaseBlockingCount}
          />
          <Metric label="コードエラー" value={displaySummary.blockingCount} />
          <Metric
            label="判断待ち"
            value={displaySummary.decisionRequiredCount}
          />
          <Metric label="注意" value={displaySummary.warningCount} />
          <Metric label="外部確認" value={displaySummary.manualCount} />
          <Metric label="任意" value={displaySummary.optionalCount} />
          <Metric
            label="出店者"
            value={`${data.sellers.activeCount}/${data.sellers.totalCount}`}
          />
          <Metric label="撤回申請" value={data.withdrawals?.openCount ?? 0} />
          <Metric
            label="撤回期限"
            value={`${data.withdrawals?.deadlineExpiredCount ?? 0}/${data.withdrawals?.deadlineSoonCount ?? 0}`}
            compact
          />
          <Metric
            label="撤回メール失敗"
            value={data.withdrawals?.emailFailedCount ?? 0}
          />
          <Metric
            label="撤回要確認"
            value={data.withdrawals?.processingIssueCount ?? 0}
          />
          <Metric
            label="定期メール"
            value={heartbeatStatusLabel(data.integrity?.heartbeat)}
            compact
          />
          <Metric
            label="注文差分"
            value={data.integrity?.sellerOrderShadow?.unresolvedCount ?? 0}
          />
          <Metric
            label="台帳補正待ち"
            value={`${data.integrity?.ledgerRepairs?.productionCount ?? 0}/${data.integrity?.ledgerRepairs?.testCount ?? 0}`}
            compact
          />
          <Metric
            label="テスト出金予定"
            value={data.integrity?.testStores?.pendingPayoutRunCount ?? 0}
          />
        </div>
      </section>

      {blockingChecks.length > 0 ? (
        <section className="readiness-card">
          <h2 className="readiness-section-title">先に直すこと</h2>
          <ul className="readiness-actions">
            {blockingChecks.map((check) => (
              <li key={check.id}>
                <strong>{check.displayTitle}</strong>:{" "}
                {check.displayAction || check.displayDetail}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="readiness-card" id="readiness-check-results">
        <h2 className="readiness-section-title">チェック結果</h2>
        <div className="readiness-table-wrap">
          <table className="readiness-table">
            <thead>
              <tr>
                <th>状態</th>
                <th>区分</th>
                <th>項目</th>
                <th>現在</th>
                <th>対応</th>
              </tr>
            </thead>
            <tbody>
              {orderedChecks.map((check) => (
                <tr key={check.id}>
                  <td>
                    <Status status={check.displayStatus} />
                  </td>
                  <td>{categoryLabel(check.category)}</td>
                  <td>{check.displayTitle}</td>
                  <td>{check.displayDetail || "-"}</td>
                  <td>
                    <div className="readiness-action-stack">
                      <span>{check.displayAction || "-"}</span>
                      {check.actionLink ? (
                        <Link
                          className="readiness-action-link"
                          to={check.actionLink.to}
                        >
                          {check.actionLink.label}
                        </Link>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="readiness-card">
        <h2 className="readiness-section-title">補足</h2>
        <p className="readiness-subtitle">
          Shopify
          Payments、KOMOJU、Wise、銀行口座などの外部側ステータスは、アプリから完全には確認できません。
          Shopify管理画面と各決済サービス側で有効状態を確認し、少額注文、返金、キャンセル、精算記録まで通してください。
          出金管理は{" "}
          <Link className="readiness-link" to="/app/payout-runs">
            出金管理
          </Link>{" "}
          から確認できます。
        </p>
      </section>
    </div>
  );
}
