/**
 * Wallet tab (spec §16.4 + the Phase 4 operational-wallet warning).
 *
 * Shows the five balance categories from the local balance ledger (fed by the
 * sync engine's indexer worker), the testnet address, and the manual faucet
 * instructions (spec: faucet claims are shown, never automated).
 */

import React, { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { WalletBalance } from "@cemp/database";
import { faucetClaimInstructions } from "@cemp/ckb";
import { useAppContainer } from "../navigation";

/** Shannon → "1,234.5 CKB" (1 CKB = 1e8 shannon). */
function formatCkb(shannon: bigint): string {
  const whole = shannon / 100_000_000n;
  const frac = shannon % 100_000_000n;
  const fracText = frac.toString().padStart(8, "0").replace(/0+$/, "");
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fracText.length > 0 ? `${wholeText}.${fracText} CKB` : `${wholeText} CKB`;
}

export function WalletScreen(): React.JSX.Element {
  const container = useAppContainer();
  const [address, setAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<WalletBalance | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!container.hasMessaging) return;
      setAddress(container.messaging.identity().address);
      void container.messaging.balances().then(setBalance);
    }, [container.hasMessaging]),
  );

  const rows: readonly (readonly [string, bigint])[] =
    balance === null
      ? []
      : [
          ["Total balance", balance.totalShannon],
          ["Available balance", balance.availableShannon],
          ["Reserved for pending messages", balance.reservedShannon],
          ["Reclaimable capacity", balance.reclaimableShannon],
          ["Pending transaction capacity", balance.pendingShannon],
        ];

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.warningBox}>
        <Text style={styles.warningTitle}>Experimental operational wallet</Text>
        <Text style={styles.warningText}>
          This is a TESTNET build. The wallet secures messaging capacity, not savings. Keep only
          what conversations need.
        </Text>
      </View>
      {address !== null ? (
        <>
          <Text style={styles.section}>Testnet address</Text>
          <Text style={styles.mono} selectable>
            {address}
          </Text>
        </>
      ) : null}
      {rows.map(([category, amount]) => (
        <View key={category} style={styles.row}>
          <Text style={styles.label}>{category}</Text>
          <Text style={styles.value}>{formatCkb(amount)}</Text>
        </View>
      ))}
      {balance === null ? (
        <Text style={styles.note}>Balances appear once the messaging service is unlocked.</Text>
      ) : null}
      {address !== null && balance !== null && balance.totalShannon === 0n ? (
        <>
          <Text style={styles.section}>Fund this wallet</Text>
          <Text style={styles.note}>{faucetClaimInstructions(address)}</Text>
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 12 },
  warningBox: {
    borderWidth: 1,
    borderColor: "#8a4b00",
    borderRadius: 8,
    padding: 14,
    backgroundColor: "#fff7ed",
  },
  warningTitle: { fontWeight: "700", color: "#8a4b00", marginBottom: 4 },
  warningText: { color: "#5c3800" },
  section: { fontSize: 16, fontWeight: "700", marginTop: 8 },
  mono: { fontFamily: "monospace", fontSize: 12 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ccc",
  },
  label: { color: "#333" },
  value: { fontVariant: ["tabular-nums"], fontWeight: "600" },
  note: { color: "#888", fontSize: 12, marginTop: 8, lineHeight: 18 },
});
