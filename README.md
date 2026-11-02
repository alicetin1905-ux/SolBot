# SolBot

Vier Solana bots die samen een pipeline vormen, live in je browser via GitHub Pages:
**https://alicetin1905-ux.github.io/SolBot/**

| # | Bot | Wat hij doet |
|---|-----|--------------|
| 1 | **Sniper** | Live feed via PumpPortal: elke nieuwe Pump.fun launch en elke migratie naar PumpSwap, direct bij creatie. Daarnaast DexScreener (profielen, boosts) en GeckoTerminal nieuwe pools. Scoort elke coin op liquiditeit, volume/liquiditeit, buy/sell ratio, momentum, leeftijd, transacties en socials. |
| 2 | **Security check** | RugCheck rapport: mint authority, freeze authority, gerugd, gevaarlijke Token-2022 extensies, transfer tax, LP locked/burned %, top 10 holders, grootste holder, insider netwerken, aantal holders, RugCheck risico's. **Honeypot test**: simuleert een koop én verkoop via Jupiter en meet het round-trip verlies. |
| 3 | **Real check** | Observeert goedgekeurde coins meerdere rondes: blijft de liquiditeit staan, gaat de prijs niet onderuit, blijven kopers komen, klopt de DexScreener prijs met Jupiter, en is de coin nog steeds verkoopbaar. Geeft een totaalscore. |
| 4 | **Paper trader** | Koopt bevestigde coins met nep-SOL, op basis van echte Jupiter quotes (inclusief price impact en tax). Exits worden elke 3 sec gecheckt via Jupiter prijzen. Max. positie = 2% van de pool. Take profit, stop loss, trailing stop, max houdtijd en rug-alarm (liquiditeit -50%). |

## Pagina's
| Pagina | Link | Inhoud |
|--------|------|--------|
| 📊 Dashboard | `#/dashboard` | **Live flow**: tegels voor de exchanges (Pump.fun, Raydium, Meteora, Orca, overig) en de 4 bots, verbonden met draden; elke coin is een pulse die doorloopt zolang hij goedgekeurd wordt. Daarnaast statistieken, mini-kaart per bot, equity grafiek, laatste trades en live log |
| 1 · Sniper | `#/sniper` | Volledige scan-tabel, instellingen en sniper log |
| 2 · Security | `#/security` | Wachtrij, alle checks per token, handmatig token checken, security log |
| 3 · Real check | `#/real` | Coins in observatie, resultaten met scores, real check log |
| 4 · Paper trader | `#/paper` | Saldo, open posities, signalen, equity grafiek, trade historie, paper log |
| 🔬 Analyse | `#/analyse` | Volgt élke gescande coin (ook afgekeurde) 5m–6u lang en meet winnaars/rugs per uitkomst, afkeur-reden, exchange, bron en score. Met automatische inzichten en CSV-export |

Alles is één app: de bots blijven draaien als je van pagina wisselt.

## Gebruik
1. Open de site en klik **Start alle bots** (of start ze één voor één).
2. Laat het tabblad open: de bots draaien in je browser.
3. Alle drempels zijn aan te passen via **⚙ Instellingen** per bot (worden lokaal opgeslagen).
4. Klik op een token voor alle security- en real-check details.
5. Plak een mint adres in het invoerveld om een specifieke coin direct te laten checken.

## Databronnen (gratis, geen API keys)
PumpPortal (websocket) · DexScreener · RugCheck · Jupiter (lite-api) · GeckoTerminal

## Let op
Dit is **alleen paper trading**: er is geen wallet en er wordt geen echt geld gebruikt.
Geen enkele check is 100% waterdicht; memecoins zijn extreem risicovol. Geen financieel advies.
