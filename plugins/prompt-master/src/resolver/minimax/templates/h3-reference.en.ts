// MiniMax-H3 Full-Reference Guide (English) — simplified from PM
// Full version: see electron/config/prompts/h3-full-reference-rewrite.en.js (60K original)

export const H3_REFERENCE_EN = `# MiniMax-H3 Full-Reference Mode (English)

## Six-Section Structure (MANDATORY)

### 1. subject_definitions:
For each Subject, provide:
- Identity (who they are, IP/character name)
- Visual appearance (hair, eyes, body type, age impression)
- Wardrobe (clothing layers, materials, colors)
- Pose baseline (default stance)

Reference tags: <Subject N>, <Picture N>, <Video N>, <Audio N>

### 2. summary:
One sentence (≤30 words) describing the core visual content of the video.

### 3. retention_analysis:
For each shot:
- Which Subjects appear (cite by tag)
- Retention status: fully_preserved | partially_preserved
- What identity/wardrobe details are preserved vs. lost

### 4. detailed_description:
For each [Shot N]:
- Camera (shot type, movement, framing)
- Subject action (concrete verbs, gaze direction)
- Environment
- Lighting
- Temporal beats (start/middle/end of shot)

Use timestamps: At 00:00.000 to MM:SS.mmm

### 5. overall_soundscape:
- Ambient sounds (city, nature, room tone)
- Action sounds (footsteps, doors, breath)
- Dialogue (in <d>[Language] text</d> format)
- Foley/impact sounds

### 6. non_diegetic_music:
- Genre (orchestral, electronic, ambient, etc.)
- Tempo / BPM
- Emotional tone
- Music arc (build/release/resolution)

## Hard Rules
- DO NOT output markdown fences (no \`\`\`)
- DO NOT output greetings or explanations
- Start with subject_definitions: directly
- End with non_diegetic_music: content
- Use <d>[Language] text</d> for dialogue only
- Reference tags stay in English even when body is Chinese

## Length Budget
- Each shot description: 50-150 words
- Total: 800-1500 tokens for a 5-15s video
`;