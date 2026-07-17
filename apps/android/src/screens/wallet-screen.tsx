/**
 * Wallet tab (spec §16.4 + the Phase 4 operational-wallet warning).
 *
 * Bootstrap state: the experimental warning the spec mandates plus the five
 * balance categories (all zero until the Phase 4 wallet-foundation card wires
 * the indexer feed). No chain actions are exposed here yet.
 */

import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

const CATEGORIES = [
  "Total balance",
  "Available balance",
  "Reserved for pending messages",
  "Reclaimable capacity",
  "Pending transaction capacity",
] as const;

export function WalletScreen(): React.JSX.Element {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.warningBox}>
        <Text style={styles.warningTitle}>Experimental operational wallet</Text>
        <Text style={styles.warningText}>
          This is a TESTNET build. The wallet secures messaging capacity, not savings. Keep only
          what conversations need.
        </Text>
      </View>
      {CATEGORIES.map((category) => (
        <View key={category} style={styles.row}>
          <Text style={styles.label}>{category}</Text>
          <Text style={styles.value}>0 CKB</Text>
        </View>
      ))}
      <Text style={styles.note}>
        Balances appear once the wallet foundation (Phase 4) is wired in.
      </Text>
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
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ccc",
  },
  label: { color: "#333" },
  value: { fontVariant: ["tabular-nums"], fontWeight: "600" },
  note: { color: "#888", fontSize: 12, marginTop: 8 },
});
