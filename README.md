# SolBot

Vier Solana bots die samen een pipeline vormen, live in je browser via GitHub Pages:
**https://alicetin1905-ux.github.io/SolBot/**

| # | Bot | Wat hij doet |
|---|-----|--------------|
| 1 | **Sniper** | Scant DexScreener (nieuwe profielen, boosts, top boosts) en GeckoTerminal nieuwe pools. Scoort elke coin op liquiditeit, volume/liquiditeit, buy/sell ratio, momentum, leeftijd, transacties en socials. |
| 2 | **Security check** | RugCheck rapport: mint authority, freeze authority, gerugd, gevaarlijke Token-2022 extensies, transfer tax, LP locked/burned %, top 10 holders, grootste holder, insider netwerken, aantal holders, RugCheck risico's. **Honeypot test**: simuleert een koop én verkoop via Jupiter en meet het round-trip verlies. |
| 3 | **Real check** | Observeert goedgekeurde coins meerdere rondes: blijft de liquiditeit staan, gaat de prijs niet onderuit, blijven kopers komen, klopt de DexScreener prijs met Jupiter, en is de coin nog steeds verkoopbaar. Geeft een totaalscore. |
| 4 | **Paper trader** | Koopt bevestigde coins met nep-SOL, op basis van echte Jupiter quotes (inclusief price impact en tax). Take profit, stop loss, trailing stop, max houdtijd en rug-alarm (liquiditeit -50%). |

## Gebruik
1. Open de site en klik **Start alle bots** (of start ze één voor één).
2. Laat het tabblad open: de bots draaien in je browser.
3. Alle drempels zijn aan te passen via **⚙ Instellingen** per bot (worden lokaal opgeslagen).
4. Klik op een token voor alle security- en real-check details.
5. Plak een mint adres in het invoerveld om een specifieke coin direct te laten checken.

## Databronnen (gratis, geen API keys)
DexScreener · RugCheck · Jupiter (lite-api) · GeckoTerminal

## Let op
Dit is **alleen paper trading**: er is geen wallet en er wordt geen echt geld gebruikt.
Geen enkele check is 100% waterdicht; memecoins zijn extreem risicovol. Geen financieel advies.
