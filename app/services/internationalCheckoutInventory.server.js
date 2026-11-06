import {
  hashNativeConfiguration,
  nativeConnectionComplete,
} from "./internationalNativeInventory.server.js";
import { internationalJpyMinorUnits } from "./internationalTransactionSnapshot.server.js";
import { proofError } from "../utils/internationalProofContract.js";

export function collectInternationalCheckoutInventory({
  markets,
  profiles,
  scope,
  variantFacts,
}) {
  const reject = () => {
    throw proofError("international_case_inventory_unverified");
  };
  return scope.map((target) => {
    const product = variantFacts.find(
      (row) => row.id === target.shopifyProductId,
    );
    if (
      !nativeConnectionComplete(product?.variants) ||
      product.variants.nodes.length !== 1 ||
      product.variants.nodes[0]?.inventoryItem?.requiresShipping !== true
    )
      reject();
    const assigned = profiles.filter((profile) =>
      profile.profileItems.nodes.some(
        (item) => item.product?.id === target.shopifyProductId,
      ),
    );
    const profile = assigned[0] || profiles.find((row) => row.default);
    if (!profile || assigned.length > 1) reject();
    const routes = [];
    for (const country of target.countries) {
      const countryMarkets = markets.filter(
        (market) =>
          market.status === "ACTIVE" &&
          market.conditions.regionsCondition.regions.nodes.some(
            (region) => region.code === country,
          ),
      );
      if (
        countryMarkets.length !== 1 ||
        countryMarkets[0].currencySettings?.baseCurrency?.currencyCode !==
          "JPY" ||
        countryMarkets[0].currencySettings?.localCurrencies !== false
      )
        reject();
      for (const group of profile.profileLocationGroups) {
        for (const zone of group.locationGroupZones.nodes) {
          if (
            !zone.zone.countries.some(
              (row) => row.code?.countryCode === country,
            )
          )
            continue;
          // Subnational and wildcard routing cannot be called whole-country coverage.
          if (
            zone.zone.countries.some(
              (row) => row.code?.restOfWorld || row.provinces.length,
            )
          )
            reject();
          for (const method of zone.methodDefinitions.nodes.filter(
            (row) => row.active,
          )) {
            const provider = method.rateProvider;
            const common = {
              country,
              profileId: profile.id,
              zoneId: zone.zone.id,
              methodId: method.id,
              providerId: provider.id,
              routeHash: hashNativeConfiguration({
                profile: profile.id,
                zone: zone.zone,
                method,
              }),
            };
            if (provider.__typename === "DeliveryRateDefinition") {
              if (provider.price?.currencyCode !== "JPY") reject();
              const price = internationalJpyMinorUnits(provider.price.amount);
              routes.push({
                ...common,
                service: "",
                routeKind: price === 0 ? "FREE" : "MANUAL",
              });
            } else {
              if (
                provider.__typename !== "DeliveryParticipant" ||
                provider.carrierService?.active !== true ||
                provider.adaptToNewServicesFlag !== false ||
                !Array.isArray(provider.participantServices) ||
                provider.participantServices.length > 20 ||
                !provider.participantServices.some((row) => row.active)
              )
                reject();
              for (const service of provider.participantServices) {
                if (typeof service.active !== "boolean") reject();
                if (service.active)
                  routes.push({
                    ...common,
                    service: service.name,
                    routeKind: "CARRIER",
                  });
              }
            }
            if (routes.length > 2048) reject();
          }
        }
      }
      if (!routes.some((row) => row.country === country)) reject();
    }
    return {
      shopifyProductId: target.shopifyProductId,
      variants: product.variants.nodes.map((row) => row.id),
      routes,
    };
  });
}
