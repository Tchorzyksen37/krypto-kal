# Brain Ingest & Analysis Skill

This skill automates the pipeline from raw X posts to a structured knowledge base and final market deliverables.

## Workflow

1. **Sync Phase**: 
   - Run `node --env-file-if-exists=.env x-sync.ts` to pull new posts from verified accounts into `raw/x/`.
   - List new files in the latest date directory.

2. **Ingest Phase (Raw $\rightarrow$ Wiki)**:
   - Read new sources.
   - For each source:
     - Identify key entities (Actors, People, Places).
     - Identify events (dated occurrences).
     - Extract factual claims with confidence levels (`confirmed`, `reported`, `unverified`, `disputed`).
     - Update/Create pages in `wiki/actors/`, `wiki/people/`, `wiki/places/`, `wiki/events/`, `wiki/themes/`, and `wiki/markets/`.
     - Append to `wiki/timeline.md`.
     - Update `wiki/index.md` and `wiki/log.md`.

3. **Synthesis Phase (Wiki $\rightarrow$ Output)**:
   - Analyze the updated wiki pages.
   - Generate a high-level briefing in `output/` based on the "Market Transmission" logic.

## Analysis Prompt

When analyzing events for the wiki and output, use the following framework:

"Analyze the following raw sources through the lens of a crypto derivatives trader. 
1. **Symmetry Check**: Compare the aggression of public rhetoric (e.g., Trump's threats) vs. the evidence of private diplomacy (e.g., secret meetings in Turkey).
2. **Transmission Chain**: Trace the impact: Event $\rightarrow$ Energy/Macro $\rightarrow$ Inflation/Rates $\rightarrow$ Asset Price.
3. **Volatility Triggers**: Identify specific 'trigger events' (e.g., a specific date or a specific sign of blockade) that would move the market from 'priced-in' to 'panic'.
4. **Confidence Scoring**: Only mark as 'confirmed' if multiple independent wires (Reuters, Bloomberg) agree. Mark OSINT/single accounts as 'unverified'.
5. **Market Reaction**: If market data is available, link the event to the specific price move (e.g., 'BTC -0.8% at 07:00 UTC')."
