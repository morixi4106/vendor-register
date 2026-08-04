import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";

import { withdrawalDetailStyles } from "./WithdrawalDetailPage.styles.js";

import {
  COMPLETION_OPTIONS,
  REFUND_DECISION_OPTIONS,
  RETURN_CONDITION_OPTIONS,
  RETURN_REQUIREMENT_OPTIONS,
  RETURN_SHIPPING_PAYER_OPTIONS,
  buildCompletionReadiness,
  buildOrderRows,
  buildProcessingDecision,
  buildProcessingSteps,
  buildQuickActions,
  buildRequestRows,
  buildReviewChecks,
  buildShopifyReconciliation,
  formatDate,
  formatDateInput,
  formatLineAmount,
  formatMoney,
  formatMoneyInputValue,
  getDeadlineSourceLabel,
  getLineIdentifier,
  getLineQuantity,
  getLineTitle,
  getNextActionItems,
  getNextActionTitle,
  getOrderCurrencyCode,
  labelFromOptions,
} from "./withdrawalDetailViewModel.js";

import {
  WITHDRAWAL_STATUSES,
  getWithdrawalStatusLabel,
} from "../../utils/withdrawalStatus.js";

export default function WithdrawalDetailPage() {
  const {
    withdrawalRequest,
    directReturnDetail,
    liveShopifyOrderStatus,
    shopifyWriteActionsEnabled,
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const currencyCode =
    withdrawalRequest.refundCurrencyCode ||
    withdrawalRequest.completionCurrencyCode ||
    getOrderCurrencyCode(withdrawalRequest) ||
    "JPY";
  const shopifyReconciliation = buildShopifyReconciliation(
    withdrawalRequest,
    currencyCode,
    liveShopifyOrderStatus,
  );
  const identityReviewRequired = [
    "ORDER_NOT_FOUND_REVIEW",
    "EMAIL_MISMATCH_REVIEW",
  ].includes(withdrawalRequest.eligibilityStatus);

  return (
    <main className="withdrawal-detail">
      <style>{withdrawalDetailStyles}</style>
      <section className="withdrawal-detail__card withdrawal-detail__header">
        <div>
          <Link to="/app/withdrawals" className="withdrawal-detail__back">
            一覧へ戻る
          </Link>
          <h1>{withdrawalRequest.shopifyOrderName || withdrawalRequest.id}</h1>
          <p>
            {withdrawalRequest.customerName} / {withdrawalRequest.customerEmail}
          </p>
          <div className="withdrawal-detail__badges">
            <Badge tone={withdrawalRequest.statusTone}>
              {withdrawalRequest.statusLabel}
            </Badge>
            <Badge tone={withdrawalRequest.eligibilityTone}>
              {withdrawalRequest.eligibilityLabel}
            </Badge>
          </div>
        </div>
        <div className="withdrawal-detail__guard">
          <strong>Shopify自動処理</strong>
          <span>{shopifyWriteActionsEnabled ? "有効" : "無効"}</span>
        </div>
      </section>

      {actionData?.message ? (
        <div
          className={`withdrawal-detail__notice ${
            actionData.ok
              ? "withdrawal-detail__notice--ok"
              : "withdrawal-detail__notice--error"
          }`}
        >
          {actionData.message}
        </div>
      ) : null}

      {identityReviewRequired ? (
        <section className="withdrawal-detail__card withdrawal-detail__alert">
          <div>
            <h2>本人確認待ち</h2>
            <p>
              申請は受け付けていますが、店舗通知・返送先の作成・商品数量の予約は停止しています。
              注文と申請者の関係を確認してから解除してください。
            </p>
          </div>
          <Form method="post">
            <input
              type="hidden"
              name="intent"
              value="approve_identity_review"
            />
            <button type="submit" disabled={isSubmitting}>
              本人確認済みとして処理を開始
            </button>
          </Form>
        </section>
      ) : null}

      {shopifyReconciliation.issues.length > 0 ? (
        <section className="withdrawal-detail__card withdrawal-detail__alert">
          <div>
            <h2>先に確認すること</h2>
            <p>
              Shopify側の注文状態と、アプリ側の撤回処理記録に確認点があります。
            </p>
          </div>
          <ul>
            {shopifyReconciliation.issues.slice(0, 4).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="withdrawal-detail__card withdrawal-detail__next">
        <h2>次にやること</h2>
        <strong>{getNextActionTitle(withdrawalRequest)}</strong>
        <ol>
          {getNextActionItems(withdrawalRequest).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </section>

      <QuickActionPanel
        request={withdrawalRequest}
        isSubmitting={isSubmitting}
      />

      <ProcessingDecisionCard
        request={withdrawalRequest}
        currencyCode={currencyCode}
      />

      <ProcessingStepsCard request={withdrawalRequest} />

      {Number(withdrawalRequest.workflowVersion || 1) === 2 ? (
        <DirectReturnWorkflowPanel
          detail={directReturnDetail}
          isSubmitting={isSubmitting}
          currencyCode={currencyCode}
        />
      ) : null}

      <section className="withdrawal-detail__grid">
        <InfoCard title="申請内容" rows={buildRequestRows(withdrawalRequest)} />
        <InfoCard
          title="注文の概要"
          rows={buildOrderRows(withdrawalRequest, currencyCode)}
        />
        {Number(withdrawalRequest.workflowVersion || 1) === 1 ? (
          <ReturnInfoCard
            request={withdrawalRequest}
            isSubmitting={isSubmitting}
          />
        ) : null}
        {Number(withdrawalRequest.workflowVersion || 1) === 1 ? (
          <RefundDecisionCard
            request={withdrawalRequest}
            currencyCode={currencyCode}
            isSubmitting={isSubmitting}
          />
        ) : null}
        <AdminStatusCard
          request={withdrawalRequest}
          isSubmitting={isSubmitting}
        />
        <CompletionCard
          request={withdrawalRequest}
          currencyCode={currencyCode}
          isSubmitting={isSubmitting}
        />
        <ShopifyReconciliationCard
          request={withdrawalRequest}
          liveShopifyOrderStatus={liveShopifyOrderStatus}
          currencyCode={currencyCode}
          reconciliation={shopifyReconciliation}
        />
        <ReviewChecklistCard request={withdrawalRequest} />
        <SelectedItemsCard data={withdrawalRequest.selectedLineItemsJson} />
        <EligibilitySummaryCard
          data={withdrawalRequest.eligibilityJson}
          request={withdrawalRequest}
        />
        <AdminNoteCard
          request={withdrawalRequest}
          isSubmitting={isSubmitting}
        />
        <TimelineCard history={withdrawalRequest.statusHistory} />
        <EmailLogCard logs={withdrawalRequest.emailLogs} />
      </section>
    </main>
  );
}

function DirectReturnWorkflowPanel({ detail, isSubmitting, currencyCode }) {
  if (!detail) {
    return (
      <section className="withdrawal-detail__card withdrawal-detail__alert">
        <h2>店舗別返送</h2>
        <p>
          V2データを読み込めません。migrationと初期化状態を確認してください。
        </p>
      </section>
    );
  }
  const groups = detail.withdrawalReturnGroups || [];
  const contracts = detail.contracts || [];
  const needsPartialLineMapping =
    String(detail.withdrawalScope || "").toUpperCase() === "PARTIAL" &&
    (detail.requestedLines || []).length === 0;
  const selectedQuantities =
    detail.selectedLineItemsJson?.selectedLineQuantities || {};

  return (
    <section className="withdrawal-detail__card">
      <h2>店舗別の返送管理</h2>
      <p className="withdrawal-detail__muted">
        返送先、返送商品、追跡、到着、検品、返金判断を店舗単位で管理します。Shopifyへの返金やキャンセルは、この画面から自動実行しません。
      </p>

      {needsPartialLineMapping ? (
        <Form
          method="post"
          className="withdrawal-detail__form"
          style={{ marginTop: 18 }}
        >
          <input
            type="hidden"
            name="intent"
            value="confirm_direct_return_line_mapping"
          />
          <input
            type="hidden"
            name="availableLineIds"
            value={(detail.availableOrderLines || [])
              .map((line) => line.id)
              .join(",")}
          />
          <div>
            <h3 style={{ margin: "0 0 8px" }}>撤回対象の商品を確定</h3>
            <p className="withdrawal-detail__muted" style={{ margin: 0 }}>
              購入者の自由記述は申告内容として残し、実際の注文商品と数量をここで確認します。数量が0の商品は対象外です。
            </p>
          </div>
          {(detail.availableOrderLines || []).length ? (
            <div className="withdrawal-detail__table-wrap">
              <table className="withdrawal-detail__table">
                <thead>
                  <tr>
                    <th>店舗</th>
                    <th>商品</th>
                    <th>購入数 / 選択可能</th>
                    <th>撤回数</th>
                    <th>商品金額</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.availableOrderLines || []).map((line) => (
                    <tr key={line.id}>
                      <td>{line.storeName}</td>
                      <td>
                        {line.title}
                        {line.sku ? <small> / SKU: {line.sku}</small> : null}
                      </td>
                      <td>
                        {line.quantity} / {line.availableQuantity}
                      </td>
                      <td>
                        <input
                          aria-label={`${line.title}の撤回数量`}
                          name={`selectedQuantity_${line.id}`}
                          type="number"
                          min="0"
                          max={line.availableQuantity}
                          step="1"
                          defaultValue={selectedQuantities[line.id] || 0}
                          disabled={line.availableQuantity <= 0}
                        />
                      </td>
                      <td>
                        {formatMoney(
                          line.netAmount,
                          line.currencyCode || currencyCode,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="withdrawal-detail__alert">
              注文商品を取得できません。注文とSellerOrderの紐付けを確認してください。
            </p>
          )}
          <button
            className="withdrawal-detail__button"
            disabled={
              isSubmitting || !(detail.availableOrderLines || []).length
            }
            type="submit"
          >
            対象商品と数量を確定
          </button>
        </Form>
      ) : null}

      {contracts.length ? (
        <div style={{ display: "grid", gap: 16, marginTop: 18 }}>
          <h3 style={{ margin: 0 }}>初回送料</h3>
          <p className="withdrawal-detail__muted" style={{ margin: 0 }}>
            通常配送分は注文全体で一度だけ配賦します。店舗数分を重複加算しないでください。
          </p>
          {contracts.map((contract) => (
            <Form
              key={contract.id}
              method="post"
              className="withdrawal-detail__form"
            >
              <input
                type="hidden"
                name="intent"
                value="update_direct_return_shipping"
              />
              <input
                type="hidden"
                name="withdrawalContractId"
                value={contract.id}
              />
              <div className="withdrawal-detail__form-grid">
                <SelectField
                  label={contract.contractPartyName || "契約"}
                  name="initialShippingRefundStatus"
                  value={contract.initialShippingRefundStatus}
                  options={[
                    "UNDECIDED",
                    "REFUND_STANDARD",
                    "NOT_REFUNDABLE",
                    "ALREADY_ALLOCATED",
                  ]}
                />
                <label>
                  <span>初回送料の返金額</span>
                  <input
                    name="initialShippingRefundAmount"
                    type="number"
                    min="0"
                    defaultValue={contract.initialShippingRefundAmount}
                  />
                </label>
              </div>
              <label>
                <span>判断理由</span>
                <input
                  name="initialShippingRefundReason"
                  defaultValue={contract.initialShippingRefundReason || ""}
                />
              </label>
              <button
                className="withdrawal-detail__button"
                disabled={isSubmitting}
                type="submit"
              >
                送料判断を保存
              </button>
            </Form>
          ))}
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 20, marginTop: 24 }}>
        {groups.length ? (
          groups.map((group) => (
            <article
              key={group.id}
              style={{ borderTop: "1px solid #e5e7eb", paddingTop: 18 }}
            >
              <div className="withdrawal-detail__header">
                <div>
                  <h3 style={{ margin: "0 0 8px" }}>
                    {group.storeNameSnapshot || "店舗"}
                  </h3>
                  <p className="withdrawal-detail__muted" style={{ margin: 0 }}>
                    {group.progressStatus} / {group.outcomeStatus}
                    {group.blockedReason ? ` / ${group.blockedReason}` : ""}
                  </p>
                </div>
                <Badge
                  tone={
                    group.blockedReason
                      ? "danger"
                      : group.instructionStatus === "SENT"
                        ? "success"
                        : "neutral"
                  }
                >
                  {group.instructionStatus === "SENT"
                    ? "返送案内済み"
                    : group.returnAddress
                      ? "案内可能"
                      : "返送先未設定"}
                </Badge>
              </div>

              {(group.shipments || []).length ? (
                <div style={{ marginTop: 14 }}>
                  <strong>返送荷物</strong>
                  <ul>
                    {group.shipments.map((shipment) => (
                      <li key={shipment.id}>
                        荷物 {shipment.packageNumber}:{" "}
                        {shipment.trackingCompany || "配送会社未入力"}{" "}
                        {shipment.trackingNumber || shipment.trackingUrl || "-"}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {group.instructionStatus !== "SENT" ? (
                <Form
                  method="post"
                  style={{ display: "grid", gap: 10, marginTop: 16 }}
                >
                  <input
                    type="hidden"
                    name="intent"
                    value="send_direct_return_instruction"
                  />
                  <input type="hidden" name="returnGroupId" value={group.id} />
                  <label>
                    <span>返送期限</span>
                    <input name="operationalReturnDeadlineAt" type="date" />
                  </label>
                  <label>
                    <span>店舗別の追記</span>
                    <textarea name="notes" rows={3} />
                  </label>
                  <button
                    className="withdrawal-detail__button"
                    disabled={isSubmitting || !group.returnAddress}
                    type="submit"
                  >
                    この店舗への返送案内を送る
                  </button>
                </Form>
              ) : null}

              <Form
                method="post"
                style={{ display: "grid", gap: 12, marginTop: 18 }}
              >
                <input
                  type="hidden"
                  name="intent"
                  value="update_direct_return_group"
                />
                <input type="hidden" name="returnGroupId" value={group.id} />
                <input
                  type="hidden"
                  name="lineIds"
                  value={(group.lines || []).map((line) => line.id).join(",")}
                />
                <div className="withdrawal-detail__form-grid">
                  <SelectField
                    label="返送証明"
                    name="evidenceStatus"
                    value={group.evidenceStatus}
                    options={[
                      "NOT_SUBMITTED",
                      "SUBMITTED",
                      "ACCEPTED",
                      "REJECTED",
                    ]}
                  />
                  <SelectField
                    label="到着状況"
                    name="receiptStatus"
                    value={group.receiptStatus}
                    options={["NOT_RECEIVED", "PARTIALLY_RECEIVED", "RECEIVED"]}
                  />
                  <SelectField
                    label="検品状況"
                    name="inspectionStatus"
                    value={group.inspectionStatus}
                    options={[
                      "NOT_INSPECTED",
                      "IN_PROGRESS",
                      "INSPECTED",
                      "VALUE_REDUCTION_REVIEW",
                    ]}
                  />
                  <SelectField
                    label="返金判断"
                    name="refundDecisionStatus"
                    value={group.refundDecisionStatus}
                    options={[
                      "UNDECIDED",
                      "FULL_REFUND",
                      "PARTIAL_REFUND",
                      "NO_REFUND",
                    ]}
                  />
                  <SelectField
                    label="最終結果"
                    name="outcomeStatus"
                    value={group.outcomeStatus}
                    options={[
                      "UNDECIDED",
                      "FULL_REFUND",
                      "PARTIAL_REFUND",
                      "NO_REFUND",
                      "CANCELLED",
                    ]}
                  />
                  <label>
                    <span>商品返金の基準額</span>
                    <input
                      name="itemRefundBaseAmount"
                      type="number"
                      min="0"
                      defaultValue={group.itemRefundBaseAmount}
                    />
                  </label>
                  <label>
                    <span>減額</span>
                    <input
                      name="deductionAmount"
                      type="number"
                      min="0"
                      defaultValue={group.deductionAmount}
                    />
                  </label>
                </div>

                <div className="withdrawal-detail__table-wrap">
                  <table className="withdrawal-detail__table">
                    <thead>
                      <tr>
                        <th>商品</th>
                        <th>案内数</th>
                        <th>提出数</th>
                        <th>到着数</th>
                        <th>状態</th>
                        <th>メモ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(group.lines || []).map((line) => (
                        <tr key={line.id}>
                          <td>{line.requestedLine.titleSnapshot}</td>
                          <td>{line.instructedQuantity}</td>
                          <td>{line.submittedQuantity}</td>
                          <td>
                            <input
                              name={`receivedQuantity_${line.id}`}
                              type="number"
                              min="0"
                              max={line.instructedQuantity}
                              defaultValue={line.receivedQuantity}
                            />
                          </td>
                          <td>
                            <select
                              name={`conditionStatus_${line.id}`}
                              defaultValue={line.conditionStatus}
                            >
                              {[
                                "UNDECIDED",
                                "UNUSED_OK",
                                "OPENED_OK",
                                "USED_REVIEW",
                                "DIRTY_REVIEW",
                                "DAMAGED_REVIEW",
                                "EXEMPT_REVIEW",
                              ].map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input
                              name={`conditionNotes_${line.id}`}
                              defaultValue={line.conditionNotes || ""}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <label>
                  <span>減額理由</span>
                  <input
                    name="deductionReason"
                    defaultValue={group.metadataJson?.deductionReason || ""}
                  />
                </label>
                <label>
                  <span>確認メモ</span>
                  <textarea
                    name="reviewNotes"
                    rows={3}
                    defaultValue={group.metadataJson?.reviewNotes || ""}
                  />
                </label>
                <p className="withdrawal-detail__muted">
                  予定返金額:{" "}
                  {formatMoney(
                    group.plannedRefundAmount,
                    group.currencyCode || currencyCode,
                  )}
                </p>
                <button
                  className="withdrawal-detail__button"
                  disabled={isSubmitting}
                  type="submit"
                >
                  店舗別の確認結果を保存
                </button>
              </Form>
            </article>
          ))
        ) : (
          <p>
            {needsPartialLineMapping
              ? "対象商品と数量を確定すると、店舗別の返送グループが作成されます。"
              : `返送グループがありません。${detail.v2ReviewReason ? `確認理由: ${detail.v2ReviewReason}` : "注文との紐付けを確認してください。"}`}
          </p>
        )}
      </div>
    </section>
  );
}

function SelectField({ label, name, value, options }) {
  return (
    <label>
      <span>{label}</span>
      <select name={name} defaultValue={value}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function QuickActionPanel({ request, isSubmitting }) {
  const actions = buildQuickActions(request);

  return (
    <section className="withdrawal-detail__card withdrawal-detail__quick-panel">
      <div>
        <h2>主要操作</h2>
        <p>
          よく使う状態変更だけを並べています。却下や期限切れなどの重い判断は、下のステータス更新で理由を入力して実行してください。
        </p>
      </div>
      {actions.length === 0 ? (
        <div className="withdrawal-detail__empty">
          この状態で使うショートカット操作はありません。
        </div>
      ) : (
        <div className="withdrawal-detail__quick-grid">
          {actions.map((action) => (
            <Form
              method="post"
              className="withdrawal-detail__quick-action"
              key={action.key}
            >
              <input type="hidden" name="intent" value="quick_transition" />
              <input type="hidden" name="quickAction" value={action.key} />
              {action.hiddenInputs.map(([name, value]) => (
                <input key={name} type="hidden" name={name} value={value} />
              ))}
              <strong>{action.label}</strong>
              <span>{action.description}</span>
              <button
                className={`withdrawal-detail__button--${action.tone}`}
                type="submit"
                disabled={isSubmitting}
              >
                実行
              </button>
            </Form>
          ))}
        </div>
      )}
    </section>
  );
}

function ProcessingDecisionCard({ request, currencyCode }) {
  const decision = buildProcessingDecision(request, currencyCode);

  return (
    <section className="withdrawal-detail__card withdrawal-detail__wide withdrawal-detail__decision">
      <div className="withdrawal-detail__decision-header">
        <div>
          <h2>処理判断</h2>
          <p>現在の状態から、管理者が次に確認するべき処理をまとめています。</p>
        </div>
        <Badge tone={decision.tone}>{decision.label}</Badge>
      </div>
      <DescriptionList rows={decision.rows} />
      {decision.items.length > 0 ? (
        <ul className="withdrawal-detail__decision-list">
          {decision.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ProcessingStepsCard({ request }) {
  const steps = buildProcessingSteps(request);

  return (
    <section className="withdrawal-detail__card withdrawal-detail__wide">
      <h2>処理ステップ</h2>
      <p className="withdrawal-detail__subtext">
        申請受付から完了通知まで、運用上の抜け漏れを確認します。
      </p>
      <div className="withdrawal-detail__steps">
        {steps.map((step) => (
          <div className="withdrawal-detail__step" key={step.label}>
            <div>
              <strong>{step.label}</strong>
              <span>{step.detail}</span>
            </div>
            <Badge tone={step.tone}>{step.status}</Badge>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReturnInfoCard({ request, isSubmitting }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>返送確認</h2>
      <DescriptionList
        rows={[
          [
            "返送状態",
            labelFromOptions(
              RETURN_REQUIREMENT_OPTIONS,
              request.returnRequirementStatus,
            ),
          ],
          ["追跡会社", request.returnTrackingCompany || "-"],
          ["追跡番号", request.returnTrackingNumber || "-"],
          ["追跡URL", request.returnTrackingUrl || "-"],
          ["返送品到着日", formatDate(request.returnReceivedAt)],
          [
            "商品状態",
            labelFromOptions(
              RETURN_CONDITION_OPTIONS,
              request.returnConditionStatus,
            ),
          ],
          ["状態メモ", request.returnConditionNotes || "-"],
        ]}
      />
      <Form
        method="post"
        className="withdrawal-detail__form withdrawal-detail__form--spaced"
      >
        <input type="hidden" name="intent" value="update_return_info" />
        <label>
          <span>返送状態</span>
          <select
            name="returnRequirementStatus"
            defaultValue={request.returnRequirementStatus || "UNDECIDED"}
          >
            {RETURN_REQUIREMENT_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>商品状態</span>
          <select
            name="returnConditionStatus"
            defaultValue={request.returnConditionStatus || "UNDECIDED"}
          >
            {RETURN_CONDITION_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="withdrawal-detail__amount-grid">
          <label>
            <span>追跡会社</span>
            <input
              name="returnTrackingCompany"
              defaultValue={request.returnTrackingCompany || ""}
            />
          </label>
          <label>
            <span>追跡番号</span>
            <input
              name="returnTrackingNumber"
              defaultValue={request.returnTrackingNumber || ""}
            />
          </label>
        </div>
        <label>
          <span>追跡URL</span>
          <input
            name="returnTrackingUrl"
            defaultValue={request.returnTrackingUrl || ""}
          />
        </label>
        <label>
          <span>返送品到着日</span>
          <input
            type="date"
            name="returnReceivedAt"
            defaultValue={formatDateInput(request.returnReceivedAt)}
          />
        </label>
        <label>
          <span>状態メモ</span>
          <textarea
            name="returnConditionNotes"
            defaultValue={request.returnConditionNotes || ""}
          />
        </label>
        <button type="submit" disabled={isSubmitting}>
          返送情報を保存
        </button>
      </Form>
      <Form method="post" className="withdrawal-detail__inline-form">
        <input type="hidden" name="intent" value="send_return_instructions" />
        <button type="submit" disabled={isSubmitting}>
          返送案内メールを送信
        </button>
      </Form>
    </section>
  );
}

function RefundDecisionCard({ request, currencyCode, isSubmitting }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>返金判断</h2>
      <DescriptionList
        rows={[
          [
            "判断",
            labelFromOptions(
              REFUND_DECISION_OPTIONS,
              request.refundDecisionStatus,
            ),
          ],
          [
            "商品代金",
            formatMoney(
              request.refundItemAmount,
              request.refundCurrencyCode || currencyCode,
            ),
          ],
          [
            "通常配送分の初回送料",
            formatMoney(
              request.refundInitialShippingAmount,
              request.refundCurrencyCode || currencyCode,
            ),
          ],
          [
            "減額",
            formatMoney(
              request.refundDeductionAmount,
              request.refundCurrencyCode || currencyCode,
            ),
          ],
          [
            "返金予定額",
            formatMoney(
              request.refundTotalAmount,
              request.refundCurrencyCode || currencyCode,
            ),
          ],
          [
            "返送送料",
            labelFromOptions(
              RETURN_SHIPPING_PAYER_OPTIONS,
              request.returnShippingPayer,
            ),
          ],
          ["理由", request.refundDecisionReason || "-"],
          ["メモ", request.refundDecisionNotes || "-"],
        ]}
      />
      <div className="withdrawal-detail__hint">
        撤回が認められる場合、商品代金と通常配送方法に相当する初回送料を返金対象として確認します。追加配送費用や返送送料は、案内内容や法令に応じて個別に判断します。
      </div>
      <Form
        method="post"
        className="withdrawal-detail__form withdrawal-detail__form--spaced"
      >
        <input type="hidden" name="intent" value="update_refund_decision" />
        <div className="withdrawal-detail__amount-grid">
          <label>
            <span>判断</span>
            <select
              name="refundDecisionStatus"
              defaultValue={request.refundDecisionStatus || "UNDECIDED"}
            >
              {REFUND_DECISION_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>返送送料</span>
            <select
              name="returnShippingPayer"
              defaultValue={request.returnShippingPayer || "UNDECIDED"}
            >
              {RETURN_SHIPPING_PAYER_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="withdrawal-detail__amount-grid">
          <AmountInput
            label="商品代金"
            name="refundItemAmount"
            value={request.refundItemAmount}
            currencyCode={request.refundCurrencyCode || currencyCode}
          />
          <AmountInput
            label="通常配送分の初回送料"
            name="refundInitialShippingAmount"
            value={request.refundInitialShippingAmount}
            currencyCode={request.refundCurrencyCode || currencyCode}
          />
          <AmountInput
            label="減額"
            name="refundDeductionAmount"
            value={request.refundDeductionAmount}
            currencyCode={request.refundCurrencyCode || currencyCode}
          />
          <label>
            <span>通貨</span>
            <input
              name="refundCurrencyCode"
              defaultValue={request.refundCurrencyCode || currencyCode}
            />
          </label>
        </div>
        <label>
          <span>判断理由</span>
          <input
            name="refundDecisionReason"
            defaultValue={request.refundDecisionReason || ""}
          />
        </label>
        <label>
          <span>メモ</span>
          <textarea
            name="refundDecisionNotes"
            defaultValue={request.refundDecisionNotes || ""}
          />
        </label>
        <button type="submit" disabled={isSubmitting}>
          返金判断を保存
        </button>
      </Form>
    </section>
  );
}

function AdminStatusCard({ request, isSubmitting }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>ステータス更新</h2>
      <Form method="post" className="withdrawal-detail__form">
        <input type="hidden" name="intent" value="update_status" />
        <label>
          <span>次の状態</span>
          <select name="toStatus" defaultValue={request.status}>
            {Object.values(WITHDRAWAL_STATUSES).map((value) => (
              <option key={value} value={value}>
                {getWithdrawalStatusLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>理由</span>
          <input name="reason" />
        </label>
        <label>
          <span>却下理由</span>
          <input
            name="rejectionReason"
            defaultValue={request.rejectionReason || ""}
          />
        </label>
        <label className="withdrawal-detail__checkbox">
          <input type="checkbox" name="sendStatusEmail" value="1" />
          <span>購入者へ状況メールを送信する</span>
        </label>
        <button type="submit" disabled={isSubmitting}>
          ステータスを更新
        </button>
      </Form>
      <div className="withdrawal-detail__button-row withdrawal-detail__quick-actions">
        <Form method="post">
          <input type="hidden" name="intent" value="resend_acknowledgement" />
          <button type="submit" disabled={isSubmitting}>
            受付メールを再送
          </button>
        </Form>
        <Form method="post">
          <input type="hidden" name="intent" value="send_status_email" />
          <button type="submit" disabled={isSubmitting}>
            状況メールを送信
          </button>
        </Form>
        <Form method="post">
          <input type="hidden" name="intent" value="send_vendor_notification" />
          <button type="submit" disabled={isSubmitting}>
            出店者へ通知
          </button>
        </Form>
      </div>
    </section>
  );
}

function CompletionCard({ request, currencyCode, isSubmitting }) {
  const readiness = buildCompletionReadiness(request, currencyCode);

  return (
    <section className="withdrawal-detail__card">
      <h2>完了記録</h2>
      <DescriptionList
        rows={[
          [
            "完了状態",
            labelFromOptions(COMPLETION_OPTIONS, request.completionStatus),
          ],
          ["実施内容", request.completionAction || "-"],
          ["Shopify返金ID", request.completionShopifyRefundId || "-"],
          ["ShopifyキャンセルID", request.completionShopifyCancelId || "-"],
          [
            "返金額",
            formatMoney(
              request.completionRefundedAmount,
              request.completionCurrencyCode || currencyCode,
            ),
          ],
          [
            "返金した送料",
            formatMoney(
              request.completionRefundedShipping,
              request.completionCurrencyCode || currencyCode,
            ),
          ],
          ["完了メモ", request.completionNotes || "-"],
          ["完了記録日時", formatDate(request.completionRecordedAt)],
          ["完了通知", formatDate(request.completionNotifiedAt)],
        ]}
      />
      <div
        className={
          readiness.tone === "success"
            ? "withdrawal-detail__ok-note"
            : "withdrawal-detail__warning-list"
        }
      >
        <strong>{readiness.label}</strong>
        <ul>
          {readiness.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <Form
        method="post"
        className="withdrawal-detail__form withdrawal-detail__form--spaced"
      >
        <input type="hidden" name="intent" value="update_completion_record" />
        <div className="withdrawal-detail__amount-grid">
          <label>
            <span>完了状態</span>
            <select
              name="completionStatus"
              defaultValue={request.completionStatus || "UNDECIDED"}
            >
              {COMPLETION_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>実施内容</span>
            <input
              name="completionAction"
              defaultValue={request.completionAction || ""}
              placeholder="例: manual_refund"
            />
          </label>
        </div>
        <div className="withdrawal-detail__amount-grid">
          <label>
            <span>Shopify返金ID</span>
            <input
              name="completionShopifyRefundId"
              defaultValue={request.completionShopifyRefundId || ""}
            />
          </label>
          <label>
            <span>ShopifyキャンセルID</span>
            <input
              name="completionShopifyCancelId"
              defaultValue={request.completionShopifyCancelId || ""}
            />
          </label>
          <AmountInput
            label="返金額"
            name="completionRefundedAmount"
            value={request.completionRefundedAmount}
            currencyCode={request.completionCurrencyCode || currencyCode}
          />
          <AmountInput
            label="返金した送料"
            name="completionRefundedShipping"
            value={request.completionRefundedShipping}
            currencyCode={request.completionCurrencyCode || currencyCode}
          />
          <label>
            <span>通貨</span>
            <input
              name="completionCurrencyCode"
              defaultValue={request.completionCurrencyCode || currencyCode}
            />
          </label>
        </div>
        <label>
          <span>完了メモ</span>
          <textarea
            name="completionNotes"
            defaultValue={request.completionNotes || ""}
          />
        </label>
        <label className="withdrawal-detail__checkbox withdrawal-detail__checkbox--guard">
          <input type="checkbox" name="confirmManualCompletion" value="1" />
          <span>
            Shopify側で返金・キャンセル・対象外処理を確認済みです。自動実行ではなく、ここではアプリ側の完了記録だけを保存します。
          </span>
        </label>
        <button type="submit" disabled={isSubmitting}>
          完了記録を保存
        </button>
      </Form>
      <Form method="post" className="withdrawal-detail__inline-form">
        <input type="hidden" name="intent" value="send_completion_email" />
        <button type="submit" disabled={isSubmitting}>
          完了通知メールを送信
        </button>
      </Form>
    </section>
  );
}

function ShopifyReconciliationCard({
  request,
  liveShopifyOrderStatus,
  currencyCode,
  reconciliation,
}) {
  const displayReconciliation =
    reconciliation ||
    buildShopifyReconciliation(request, currencyCode, liveShopifyOrderStatus);

  return (
    <section className="withdrawal-detail__card">
      <div className="withdrawal-detail__section-header">
        <div>
          <h2>Shopify突合</h2>
          <p className="withdrawal-detail__subtext">
            Shopify側の注文記録と、アプリ側の返金・キャンセル完了記録を確認します。
          </p>
        </div>
        {displayReconciliation.adminOrderUrl ? (
          <a
            className="withdrawal-detail__link-button"
            href={displayReconciliation.adminOrderUrl}
            target="_blank"
            rel="noreferrer"
          >
            Shopify注文を開く
          </a>
        ) : null}
      </div>
      <DescriptionList rows={displayReconciliation.rows} />
      {liveShopifyOrderStatus?.checkedAt ? (
        <div
          className={
            liveShopifyOrderStatus.ok
              ? "withdrawal-detail__ok-note"
              : "withdrawal-detail__warning-list"
          }
        >
          <strong>
            {liveShopifyOrderStatus.ok
              ? "Shopifyライブ状態を取得しました"
              : "Shopifyライブ状態を取得できませんでした"}
          </strong>
          <p>
            {liveShopifyOrderStatus.ok
              ? `${formatDate(liveShopifyOrderStatus.checkedAt)} 時点の注文状態を併せて表示しています。`
              : `理由: ${liveShopifyOrderStatus.error || "unknown"}`}
          </p>
        </div>
      ) : null}
      {displayReconciliation.issues.length > 0 ? (
        <div className="withdrawal-detail__warning-list">
          <strong>確認が必要です</strong>
          <ul>
            {displayReconciliation.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="withdrawal-detail__ok-note">
          現時点で大きな不整合は見つかっていません。
        </div>
      )}
    </section>
  );
}

function AdminNoteCard({ request, isSubmitting }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>管理者メモ</h2>
      <Form method="post" className="withdrawal-detail__form">
        <input type="hidden" name="intent" value="add_admin_note" />
        <label>
          <span>メモ</span>
          <textarea name="adminNotes" defaultValue={request.adminNotes || ""} />
        </label>
        <button type="submit" disabled={isSubmitting}>
          メモを保存
        </button>
      </Form>
    </section>
  );
}

function InfoCard({ title, rows }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>{title}</h2>
      <DescriptionList rows={rows} />
    </section>
  );
}

function DescriptionList({ rows }) {
  return (
    <dl className="withdrawal-detail__dl">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value || "-"}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReviewChecklistCard({ request }) {
  const checks = buildReviewChecks(request);

  return (
    <section className="withdrawal-detail__card withdrawal-detail__wide">
      <h2>確認チェック</h2>
      <p className="withdrawal-detail__subtext">
        申請を進める前に、最低限ここだけ確認します。自動返金や自動キャンセルはまだ実行しません。
      </p>
      <div className="withdrawal-detail__checklist">
        {checks.map((check) => (
          <div className="withdrawal-detail__check" key={check.label}>
            <div>
              <strong>{check.label}</strong>
              <span>{check.detail}</span>
            </div>
            <Badge tone={check.tone}>{check.status}</Badge>
          </div>
        ))}
      </div>
    </section>
  );
}

function SelectedItemsCard({ data }) {
  const scope = data?.scope === "PARTIAL" ? "一部の商品" : "注文全体";
  const selectedLineItems = Array.isArray(data?.selectedLineItems)
    ? data.selectedLineItems
    : [];
  const orderLineItems = Array.isArray(data?.orderLineItems)
    ? data.orderLineItems
    : [];

  return (
    <section className="withdrawal-detail__card withdrawal-detail__wide">
      <h2>対象商品</h2>
      <DescriptionList
        rows={[
          ["撤回対象", scope],
          ["購入者の入力", data?.freeText || "-"],
          [
            "選択された商品",
            selectedLineItems.length > 0 ? selectedLineItems.join(" / ") : "-",
          ],
        ]}
      />

      {orderLineItems.length > 0 ? (
        <div className="withdrawal-detail__table-wrap">
          <table className="withdrawal-detail__table">
            <thead>
              <tr>
                <th>商品</th>
                <th>SKU / ID</th>
                <th>数量</th>
                <th>金額</th>
              </tr>
            </thead>
            <tbody>
              {orderLineItems.map((line, index) => (
                <tr key={getLineIdentifier(line) || index}>
                  <td>{getLineTitle(line)}</td>
                  <td>{getLineIdentifier(line) || "-"}</td>
                  <td>{getLineQuantity(line)}</td>
                  <td>{formatLineAmount(line)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="withdrawal-detail__empty">
          注文明細は記録されていません。購入者の入力内容とShopify注文を照合してください。
        </div>
      )}

      <RawJsonDetails data={data} />
    </section>
  );
}

function EligibilitySummaryCard({ data, request }) {
  const warnings = Array.isArray(data?.warnings) ? data.warnings : [];

  return (
    <section className="withdrawal-detail__card">
      <h2>判定情報</h2>
      <DescriptionList
        rows={[
          ["判定", request.eligibilityLabel],
          ["EU対象", data?.isEuCountry ? "EU対象" : "要確認"],
          ["注文照合", data?.orderFound ? "照合済み" : "要確認"],
          [
            "メール照合",
            data?.orderEmailMatched ? "一致または未判定" : "不一致",
          ],
          ["期限", formatDate(data?.deadlineAt || request.deadlineAt)],
          [
            "期限の根拠",
            getDeadlineSourceLabel(
              data?.deadlineSource || request.deadlineSource,
            ),
          ],
          ["判定日時", formatDate(data?.evaluatedAt)],
        ]}
      />

      {warnings.length > 0 ? (
        <div className="withdrawal-detail__warning-list">
          <strong>確認メモ</strong>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="withdrawal-detail__ok-note">
          自動判定上の警告はありません。
        </div>
      )}

      <RawJsonDetails data={data} />
    </section>
  );
}

function RawJsonDetails({ data }) {
  if (!data) return null;

  return (
    <details className="withdrawal-detail__raw">
      <summary>詳細JSONを表示</summary>
      <pre className="withdrawal-detail__pre">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

function JsonCard({ title, data }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>{title}</h2>
      {data ? (
        <pre className="withdrawal-detail__pre">
          {JSON.stringify(data, null, 2)}
        </pre>
      ) : (
        <div className="withdrawal-detail__empty">記録はありません。</div>
      )}
    </section>
  );
}

function TimelineCard({ history }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>ステータス履歴</h2>
      {history.length === 0 ? (
        <div className="withdrawal-detail__empty">履歴はありません。</div>
      ) : (
        <div className="withdrawal-detail__timeline">
          {history.map((item) => (
            <div key={item.id}>
              <strong>
                {item.fromStatus
                  ? getWithdrawalStatusLabel(item.fromStatus)
                  : "-"}{" "}
                → {getWithdrawalStatusLabel(item.toStatus)}
              </strong>
              <span>
                {formatDate(item.createdAt)} / {item.changedBy || "-"} /{" "}
                {item.reason || "-"}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function EmailLogCard({ logs }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>メール履歴</h2>
      {logs.length === 0 ? (
        <div className="withdrawal-detail__empty">メール履歴はありません。</div>
      ) : (
        <div className="withdrawal-detail__timeline">
          {logs.map((log) => (
            <div key={log.id}>
              <strong>
                {log.emailType} / {log.status === "sent" ? "送信済み" : "失敗"}
              </strong>
              <span>
                {formatDate(log.sentAt || log.createdAt)} / {log.toEmail}
              </span>
              {log.errorMessage ? (
                <p className="withdrawal-detail__error">{log.errorMessage}</p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AmountInput({ label, name, value, currencyCode = "JPY" }) {
  const digits = getCurrencyMinorUnitDigits(currencyCode);

  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min="0"
        step={digits === 0 ? "1" : "0.01"}
        name={name}
        defaultValue={formatMoneyInputValue(value, currencyCode)}
      />
    </label>
  );
}

function Badge({ tone, children }) {
  return (
    <span
      className={`withdrawal-detail__badge withdrawal-detail__badge--${tone}`}
    >
      {children}
    </span>
  );
}
