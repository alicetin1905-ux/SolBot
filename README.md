# SolBot

Vier Solana bots die samen een pipeline vormen, live in je browser via GitHub Pages:
**https://alicetin1905-ux.github.io/SolBot/**

| # | Bot | Wat hij doet |
|---|-----|--------------|
| 1 | **Sniper** | Live feed via PumpPortal: elke nieuwe Pump.fun launch en elke migratie naar PumpSwap, direct bij creatie. Daarnaast DexScreener (profielen, boosts, community takeovers) en GeckoTerminal (nieuwe + trending pools op alle DEXen en launchpads). Scoort elke coin op liquiditeit, volume/liquiditeit, buy/sell ratio, momentum, leeftijd, transacties en socials. |
| 2 | **Security check** | Jupiter audit (organic score tegen wash trading, verdacht-vlag; en fallback als RugCheck niet werkt) + RugCheck rapport: mint authority, freeze authority, gerugd, gevaarlijke Token-2022 extensies, transfer tax, LP locked/burned %, top 10 holders, grootste holder, insider netwerken, aantal holders, RugCheck risico's. **Honeypot test**: simuleert een koop én verkoop via Jupiter en meet het round-trip verlies. **Dev-checks** (via de Jupiter wallet-holdings): hoeveel de dev nog bezit, hoeveel hij van zijn launch-aankoop al verkocht heeft, en hoeveel tokens hij al gemaakt heeft. Waarschuwt als een LP-lock binnenkort afloopt. |
| 3 | **Real check** | Observeert goedgekeurde coins meerdere rondes: blijft de liquiditeit staan, gaat de prijs niet onderuit, blijven kopers komen, klopt de DexScreener prijs met Jupiter, en is de coin nog steeds verkoopbaar. Geeft een totaalscore. |
| 4 | **Paper trader** | Koopt bevestigde coins met nep-SOL op echte Jupiter quotes. **Kopen:** grootte op basis van totaalscore, max. 2% van de pool, max. round-trip kosten, na een pump eerst wachten op een terugval. **Verkopen:** stop loss, break-even stop, deelverkoop, take profit, trailing stop, verkoopdruk, dode coin, max houdtijd, rug-alarm (elke 3 sec). **Risico:** daglimiet, pauze na verliesreeks, nooit dezelfde coin opnieuw. Verkoopt direct als de dev dumpt. **Realistisch:** vertraging per transactie, kans op mislukte transacties en slippage-checks, met fees ook bij mislukte pogingen. |

## 24/7 op je Mac
Open **Terminal** op de Mac en plak:

```bash
curl -fsSL https://raw.githubusercontent.com/alicetin1905-ux/SolBot/main/server/install-mac.sh | bash
```

Dat installeert SolBot in `~/SolBot`, start de server automatisch (ook na een herstart) en houdt de Mac wakker.
Je data staat in `~/SolBot-data`. Aan het eind toont Terminal de adressen en een **toegangscode**.

- **Op de Mac:** http://localhost:8787
- **Thuis op je iPhone (zelfde wifi):** `http://<naam-van-je-mac>.local:8787` → Deel → Zet op beginscherm
- **Updaten:** plak hetzelfde commando opnieuw · **Log:** `tail -f ~/SolBot-data/server.log`
- **Pushmeldingen:** tik in het dashboard op 🔕 en volg de stappen (gratis app *ntfy*).
- **Data meenemen:** 💾 Backup op de Analyse-pagina van de oude versie, en ♻️ Backup terugzetten op de Mac.

**Buitenshuis (Tailscale):** installeer Tailscale op de Mac en iPhone (zelfde account), en draai op de Mac eenmalig
`/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg <poort>` (de poort uit de installatie, bijv. 8788).
Daarna is SolBot overal bereikbaar via `https://<mac-naam>.<tailnet>.ts.net/` zolang Tailscale op je iPhone aan staat.

Het dashboard ziet zelf of het van de Mac komt (groene badge met de naam van je Mac): dan draaien de bots op de Mac
en sturen alle knoppen hun opdracht naar de Mac. De GitHub Pages-versie blijft gewoon werken in de browser.

## Op je iPhone als app
1. Open **https://alicetin1905-ux.github.io/SolBot/** in **Safari**.
2. Tik op **Deel** (vierkantje met pijl omhoog) → **Zet op beginscherm** → **Voeg toe**.
3. Open SolBot via het nieuwe icoon: fullscreen, zonder adresbalk.
4. Tik in de app op **🔕** om meldingen aan te zetten (iOS 16.4 of nieuwer).

Zolang de bots draaien blijft het scherm aan. Let op: als je de iPhone vergrendelt of naar een andere app gaat,
pauzeert iOS de app en stoppen de bots. Voor 24/7 draaien komt de Mac-server.

## Profielen
Bovenaan wissel je met één klik tussen **🛡️ Voorzichtig** (strenge filters), **⚖️ Normaal** en **🔥 Agressief**
(zoveel mogelijk coins, meer risico). Pas je zelf iets aan, dan staat er **✏️ Aangepast**. De Analyse-pagina
vergelijkt per profiel hoeveel winnaars en rugs er doorkwamen.

## Pagina's
| Pagina | Link | Inhoud |
|--------|------|--------|
| 📊 Dashboard | `#/dashboard` | Alleen tegels: exchanges (Pump.fun, Raydium, Meteora, Orca, overig), de 4 bots en Analyse, verbonden met draden. Elke coin is een pulse die doorloopt zolang hij goedgekeurd wordt. Elke tegel toont de kerncijfers, top-coins, voortgang en laatste gebeurtenis; klik om de pagina te openen |
| 1 · Sniper | `#/sniper` | Volledige scan-tabel, instellingen en sniper log |
| 2 · Security | `#/security` | Wachtrij, alle checks per token, handmatig token checken, security log |
| 3 · Real check | `#/real` | Coins in observatie, resultaten met scores, real check log |
| 4 · Paper trader | `#/paper` | Saldo, open posities, signalen, equity grafiek, trade historie, paper log |
| 🔬 Analyse | `#/analyse` | Volgt élke gescande coin (ook afgekeurde) 5m–6u lang en meet winnaars/rugs per uitkomst, afkeur-reden, exchange, bron en score. Met automatische inzichten, trade-analyse (per verkoopreden, score, bron, profiel, exchange), een **exit-optimizer** (speelt het echte prijsverloop van bevestigde coins opnieuw af), een **filter-optimizer** (test ±5.700 combinaties van sniper-drempels) en een **geleerde score** (een model dat leert welke kenmerken winnaars voorspellen en optioneel als sniper-filter werkt), plus CSV-export |

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

## Ontwikkelen
Lokaal de server testen: `node server/solbot-server.mjs` (Node 22+, data in `~/SolBot-data` of `$SOLBOT_DATA`, poort `$PORT`).
Draai `./tools/bump-version.sh` vóór elke commit die `js/` of `css/` wijzigt. Dat zet één versienummer op alle
bestanden, zodat browsers na een update nooit oude en nieuwe bestanden door elkaar laden.
