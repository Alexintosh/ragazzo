import { MenuView } from "@expo/ui/community/menu";
import type { BillingStatus, HostedCreditStatus } from "@rakazo/contracts";
import {
  DEFAULT_MONTHLY_CREDIT_AMOUNT,
  MODEL_CREDIT_AMOUNTS,
  ModelCreditAmountSchema,
} from "@rakazo/contracts";
import { formatCreditAmount } from "@rakazo/core";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, AppState, ScrollView, Share, StyleSheet } from "react-native";
import { SettingsGroup, SettingsRow, useStackedSettings } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { currentPlan, openBillingPage, planEndsAt } from "../../lib/billing";
import { dateLocaleForUi, useI18n } from "../../lib/i18n";
import { queryClient, rpcQuery } from "../../lib/query";
import { openFromSettingsSheet } from "../../lib/settings-sheet";
import { useSideInsets } from "../../lib/side-insets";

type Amount = (typeof MODEL_CREDIT_AMOUNTS)[number];

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(dateLocaleForUi(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function BillingScreen() {
  const sideInsets = useSideInsets();
  const stacked = useStackedSettings();
  const { t } = useI18n();
  const router = useRouter();
  const [hosted, setHosted] = useState<HostedCreditStatus | null>(null);
  const [stripeEnabled, setStripeEnabled] = useState(false);
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [amount, setAmount] = useState<Amount>(DEFAULT_MONTHLY_CREDIT_AMOUNT);
  const [pending, setPending] = useState(false);
  const show = useCallback((next: BillingStatus) => {
    setStatus(next);
    setAmount(
      ModelCreditAmountSchema.catch(DEFAULT_MONTHLY_CREDIT_AMOUNT).parse(next.monthlyAmountCents),
    );
  }, []);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const load = () => {
        void rpc("me")
          .then(async (me) => {
            if (active) setStripeEnabled(me.billingEnabled);
            const [next, credits] = await Promise.all([
              me.billingEnabled || me.hostedCreditsEnabled
                ? rpc("billing/status")
                : Promise.resolve(null),
              me.hostedCreditsEnabled ? rpc("hostedCredits/status") : Promise.resolve(null),
            ]);
            if (active) {
              if (next) show(next);
              setHosted(credits);
            }
          })
          .catch(() => {
            if (active) Alert.alert(t("Could not load billing"));
          });
      };
      load();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") load();
      });
      return () => {
        active = false;
        subscription.remove();
      };
    }, [show, t]),
  );
  async function action(work: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    try {
      await work();
    } catch {
      Alert.alert(t("Could not update billing"));
    } finally {
      setPending(false);
    }
  }
  async function selectHostedFunding(funding: "byok" | "credits") {
    await rpc("billing/selectFunding", { funding });
    const [next, credits] = await Promise.all([rpc("billing/status"), rpc("hostedCredits/status")]);
    show(next);
    setHosted(credits);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: rpcQuery("me").queryKey }),
      queryClient.invalidateQueries({ queryKey: rpcQuery("models/list").queryKey }),
      queryClient.invalidateQueries({ queryKey: rpcQuery("models/credentials").queryKey }),
      queryClient.invalidateQueries({ queryKey: rpcQuery("billing/status").queryKey }),
      queryClient.invalidateQueries({ queryKey: rpcQuery("hostedCredits/status").queryKey }),
    ]);
  }
  if (!status && !hosted) return null;
  if (!stripeEnabled && hosted)
    return (
      <ScrollView
        style={sideInsets}
        contentContainerStyle={[styles.content, stacked && styles.compactContent]}
        contentInsetAdjustmentBehavior="automatic"
      >
        <HostedCreditRows
          hosted={hosted}
          status={status}
          pending={pending}
          onFundingChange={
            stripeEnabled ? undefined : (funding) => void action(() => selectHostedFunding(funding))
          }
        />
      </ScrollView>
    );
  if (!status) return null;

  const plan = currentPlan(status);
  const endsAt = planEndsAt(status);
  const recurring = Boolean(
    status.monthlyAmountCents && !["none", "canceled", "incomplete"].includes(status.state),
  );
  // Owners can always top up, as on web; a top-up is how an own-key plan starts on credits.
  const credits = status.funding === "credits" || (status.balanceUsd ?? 0) > 0 || status.canManage;
  const referral = status.referral;
  return (
    <ScrollView
      style={sideInsets}
      contentContainerStyle={[styles.content, stacked && styles.compactContent]}
      contentInsetAdjustmentBehavior="automatic"
    >
      {hosted ? (
        <HostedCreditRows
          hosted={hosted}
          status={status}
          pending={pending}
          onFundingChange={
            stripeEnabled ? undefined : (funding) => void action(() => selectHostedFunding(funding))
          }
        />
      ) : null}
      <SettingsGroup>
        <SettingsRow
          title={t("Plan")}
          value={
            status.state === "trialing" || status.byokFreeUntil
              ? t("Free trial")
              : plan === "byok"
                ? t("Your subscription or API key")
                : plan === "credits"
                  ? t("Rakazo credits")
                  : t("None")
          }
        />
        {endsAt ? (
          <SettingsRow
            title={status.cancelAtPeriodEnd ? t("Ends") : t("Free until")}
            value={formatDate(endsAt)}
          />
        ) : status.access && status.currentPeriodEndsAt ? (
          <SettingsRow title={t("Renews")} value={formatDate(status.currentPeriodEndsAt)} />
        ) : null}
        {status.canManage ? (
          <SettingsRow
            title={plan && !status.byokFreeUntil ? t("Change plan") : t("Choose a plan")}
            prominent
            onPress={() => openFromSettingsSheet(router, "/paywall?dismissible=1")}
          />
        ) : null}
      </SettingsGroup>
      {status.computerHoursLeft != null ? (
        <SettingsGroup>
          <SettingsRow title={t("Computer hours left")} value={String(status.computerHoursLeft)} />
        </SettingsGroup>
      ) : null}
      {referral ? (
        <SettingsGroup footer={t("Get a free month for each friend who starts a trial.")}>
          <SettingsRow
            title={t("Invite friends")}
            detail={
              referral.rewards === 0
                ? undefined
                : referral.rewards === 1
                  ? t("1 free month earned")
                  : t("{count} free months earned", { count: referral.rewards })
            }
            chevron="right"
            onPress={() => void Share.share({ message: referral.url }).catch(() => undefined)}
          />
        </SettingsGroup>
      ) : null}
      {credits ? (
        <SettingsGroup
          label={t("Credits")}
          footer={
            recurring ? t("Monthly credits expire at renewal. Top-ups do not expire.") : undefined
          }
        >
          <SettingsRow
            title={t("Available credits")}
            value={`$${(status.balanceUsd ?? 0).toFixed(2)}`}
          />
          {status.canManage && recurring ? (
            <>
              <MenuView
                actions={MODEL_CREDIT_AMOUNTS.map((value) => ({
                  id: String(value),
                  title: `$${value / 100} / month`,
                  state: amount === value ? ("on" as const) : ("off" as const),
                }))}
                onPressAction={({ nativeEvent }) =>
                  setAmount(ModelCreditAmountSchema.parse(Number(nativeEvent.event)))
                }
              >
                <SettingsRow
                  title={t("Monthly credits")}
                  value={`$${amount / 100} / month`}
                  chevron="down"
                  disabled={pending}
                />
              </MenuView>
              {amount !== status.monthlyAmountCents ? (
                <SettingsRow
                  title={
                    amount > (status.monthlyAmountCents ?? 0)
                      ? t("Upgrade now")
                      : t("Downgrade at renewal")
                  }
                  disabled={pending}
                  onPress={() =>
                    void action(async () => {
                      await rpc("billing/setMonthlyCredits", { amountCents: amount });
                      show(await rpc("billing/refresh"));
                    })
                  }
                />
              ) : null}
            </>
          ) : null}
          {status.canManage ? (
            <MenuView
              actions={MODEL_CREDIT_AMOUNTS.map((value) => ({
                id: String(value),
                title: `$${value / 100}`,
              }))}
              onPressAction={({ nativeEvent }) =>
                void action(async () => {
                  const result = await rpc("billing/purchaseCredits", {
                    amountCents: ModelCreditAmountSchema.parse(Number(nativeEvent.event)),
                    monthly: false,
                    client: "mobile",
                  });
                  show(await openBillingPage(result.url));
                })
              }
            >
              <SettingsRow
                title={t("Add credits")}
                chevron="right"
                disabled={pending || !status.creditPurchasesEnabled}
              />
            </MenuView>
          ) : null}
          {status.canManage && status.funding === "byok" && (status.balanceUsd ?? 0) > 0 ? (
            <SettingsRow
              title={t("Use Rakazo credits")}
              disabled={pending || !status.creditPurchasesEnabled}
              onPress={() =>
                void action(async () => {
                  await rpc("billing/selectFunding", { funding: "credits" });
                  router.replace("/models");
                })
              }
            />
          ) : null}
        </SettingsGroup>
      ) : null}
      {status.canManage && status.hasCustomer ? (
        <SettingsGroup>
          <SettingsRow
            title={t("Manage billing")}
            chevron="right"
            disabled={pending}
            onPress={() =>
              void action(async () => {
                const result = await rpc("billing/portal", { client: "mobile" });
                show(await openBillingPage(result.url));
              })
            }
          />
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

function HostedCreditRows({
  hosted,
  status,
  pending,
  onFundingChange,
}: {
  hosted: HostedCreditStatus;
  status: BillingStatus | null;
  pending: boolean;
  onFundingChange?: (funding: "byok" | "credits") => void;
}) {
  const { t } = useI18n();
  const locale = dateLocaleForUi();
  return (
    <SettingsGroup
      label={t("Rakazo credits")}
      footer={t("1 credit = $0.001. Daily grants use UTC.")}
    >
      {!hosted.available ? <SettingsRow title={t("Hosted models are paused")} /> : null}
      <SettingsRow
        title={t("Available credits")}
        value={formatCreditAmount(hosted.balanceMicros, locale)}
      />
      <SettingsRow
        title={t("Daily credits")}
        value={formatCreditAmount(hosted.dailyAllowanceMicros, locale)}
      />
      {hosted.nextGrantAt ? (
        <SettingsRow
          title={t("Renews")}
          value={new Date(hosted.nextGrantAt).toLocaleString(locale)}
        />
      ) : null}
      {status?.canManage && onFundingChange ? (
        <SettingsRow
          title={
            status.funding === "byok"
              ? t("Use Rakazo credits")
              : t("Use my subscription or API key")
          }
          disabled={pending || (status.funding === "byok" && !hosted.available)}
          onPress={() => onFundingChange(status.funding === "byok" ? "credits" : "byok")}
        />
      ) : null}
    </SettingsGroup>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, gap: 28 },
  compactContent: { paddingHorizontal: 8 },
});
