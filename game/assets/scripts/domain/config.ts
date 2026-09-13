/** Validate both the current design and a supported immutable run snapshot. */
export function validateConfig(c: any): void {
  const check = (ok: unknown, reason: string) => { if (!ok) throw new Error(`配置错误：${reason}`); };
  check(c && ['0.5', '0.6', '0.7'].includes(c.design_version), '不支持的设计版本');
  const hasBossStages = c.design_version === '0.7';
  for (const [key, count] of [['heroes', 4], ['monsters', hasBossStages ? 8 : 7], ['skills', 7], ['cards', 15], ['forms', 12], ['waves', 20]] as const) {
    check(c[key]?.length === count, `${key}数量`);
    const ids = c[key].map((v: any) => v.id ?? v.wave);
    check(new Set(ids).size === ids.length, `${key}重复ID`);
  }
  if (hasBossStages) {
    check(c.flow && Object.keys(c.flow).sort().join() === 'auto_start_after_card,auto_wave_countdown_real_seconds,placement_combat_scale', '0.7流程字段');
    check(c.flow.auto_start_after_card === true, '选卡后自动开波');
    check(c.flow.auto_wave_countdown_real_seconds === 1.2, '自动开波真实秒倒计时');
    check(c.flow.placement_combat_scale === 0.2, '布阵战斗时间倍率');
  } else check(c.flow === undefined, '旧版快照不能启用新流程');
  check(c.clock.tick_hz === 60 && c.run.max_star === 3, '时钟或局内星级');
  check(c.progression.level_costs.length === c.progression.level_cap - 1, '逐级成本缺失');
  check(c.progression.level_costs.every((v: number) => v > 0), '升级成本必须为正');
  check(c.progression.damage_multipliers_by_level.length === c.progression.level_cap, '等级倍率缺失');
  const ids = (k: string) => new Set(c[k].map((v: any) => v.id));
  const monsters = new Map<string, any>(c.monsters.map((m: any) => [m.id, m]));
  const splitChildren = new Set<string>();
  for (const m of c.monsters) {
    check(['normal', 'elite', 'boss'].includes(m.control_class), `${m.id}怪物类别`);
    check(Number.isFinite(m.hp_base) && m.hp_base > 0 && Number.isFinite(m.speed_units_per_second) && m.speed_units_per_second > 0, `${m.id}生命/速度`);
    check(Number.isInteger(m.reward_energy) && m.reward_energy >= 0, `${m.id}奖励`);
    if (m.hp_by_wave) {
      check(hasBossStages && m.id === 'B002' && m.control_class === 'boss' && m.uses_wave_hp_multiplier === false, '按波生命仅供小Boss');
      check(Object.keys(m.hp_by_wave).map(Number).sort((a,b)=>a-b).join() === '5,10,15', '小Boss生命波次');
      const hp = [5,10,15].map(w => m.hp_by_wave[w]);
      check(hp.every(v => Number.isFinite(v) && v > 0) && hp[0] === m.hp_base && hp[0] < hp[1] && hp[1] < hp[2], '小Boss生命必须逐阶段增加');
    }
    if (m.split) {
      const split = m.split, child = monsters.get(split.child_id);
      check(child && !child.split && Number.isInteger(split.count) && split.count > 0, `${m.id}分裂子体引用`);
      check(split.reward_budget_shared === m.reward_energy && child.reward_energy * split.count === m.reward_energy && split.normal_parent_death_reward === 0, `${m.id}分裂共享预算`);
      check(split.child_upstream_offsets.length === split.count, `${m.id}分裂位置数量`);
      splitChildren.add(split.child_id);
    }
  }
  for (const h of c.heroes) {
    check(ids('skills').has(h.player_skill_id), `${h.id}技能引用`);
    check(c.forms.some((f: any) => f.id === h.default_form_id && f.hero_id === h.id && f.unlock_level === 1), '初始形态');
    check(h.interval_seconds > 0 && h.range_units > 0 && h.windup_seconds > 0, '英雄周期/射程');
    check(h.star_multipliers.length === 3, '星级倍率');
    const forms = c.forms.filter((f: any) => f.hero_id === h.id);
    check(forms.map((f: any) => f.unlock_level).join() === c.progression.form_unlock_levels.join(), '形态解锁级');
  }
  for (const f of c.forms) {
    check(ids('heroes').has(f.hero_id) && f.additional_stats === false, '形态归属/数值');
    check(!Object.keys(f).some(k => /damage|cooldown/.test(k)), '形态不能覆盖战斗参数');
  }
  check(c.world.pads.length === 9 && c.world.reserve_ids.length === 3, '9+3位置');
  check(new Set([...c.world.pads.map((p: any) => p.id), ...c.world.reserve_ids]).size === 12, '重复位置');
  check(c.world.base_y - c.world.spawn_y === c.world.lane_length, '道路长度');
  for (const p of c.world.pads) {
    check(p.x >= 30 && p.x <= 690 && p.y >= 30 && p.y <= 650, '位置越界');
    check(c.world.lane_centers_x.every((x: number) => Math.abs(p.x-x) >= c.world.road_width/2+c.world.pad_radius), '部署位在道路上');
  }
  let roots = 0, energy = 0, ordinaryRoots = 0, ordinaryEnergy = 0, bossRoots = 0, bossEnergy = 0, splitParents = 0, splitCount = 0;
  let previousOrdinaryCount = -1;
  for (const w of c.waves) {
    check(Number.isInteger(w.wave) && w.wave >= 1 && w.wave <= 20, '波号范围');
    let count = 0, budget = 0, normalCount = 0, normalBudget = 0, waveBossCount = 0, waveBossBudget = 0;
    for (const id of Object.keys(w.counts)) {
      check(ids('monsters').has(id) && Number.isInteger(w.counts[id]) && w.counts[id] >= 0, '波次怪物');
      check(!splitChildren.has(id) || w.counts[id] === 0, '分裂子体不能重复列为根怪');
      const m = monsters.get(id), n = w.counts[id], amount = n * m.reward_energy;
      count += n; budget += amount;
      if (m.control_class === 'boss') { waveBossCount += n; waveBossBudget += amount; }
      else { normalCount += n; normalBudget += amount; }
      if (m.split) { splitParents += n; splitCount += n * m.split.count; }
    }
    check(count === w.root_count && budget === w.energy_budget, `第${w.wave}波数量/预算`);
    if (c.design_version !== '0.5') {
      check(normalCount === 8 + 2 * (w.wave - 1) && normalCount > previousOrdinaryCount, `第${w.wave}波普通根怪递增`);
      check(normalBudget >= 80 && w.non_boss_root_count === normalCount && w.non_boss_energy_budget === normalBudget && w.boss_energy_budget === waveBossBudget, `第${w.wave}波普通/Boss预算`);
      check(waveBossBudget === 200 * waveBossCount, `第${w.wave}波Boss本体奖励`);
    }
    if (hasBossStages) {
      check((w.counts.B001 || 0) === (w.wave === 20 ? 1 : 0) && (w.counts.B002 || 0) === ([5,10,15].includes(w.wave) ? 1 : 0), `第${w.wave}波Boss安排`);
    }
    roots += count; energy += budget;
    ordinaryRoots += normalCount; ordinaryEnergy += normalBudget; bossRoots += waveBossCount; bossEnergy += waveBossBudget;
    previousOrdinaryCount = normalCount;
  }
  check(roots === c.expected_totals.root_monsters && energy === c.expected_totals.ordinary_energy_budget, '总预算');
  check(splitParents === c.expected_totals.split_parents && splitCount === c.expected_totals.max_split_children && roots + splitCount === c.expected_totals.max_spawned_entities, '分裂实体总量');
  check(c.run.starting_energy + energy === c.expected_totals.starting_plus_ordinary_energy, '开局加完整预算');
  if (c.design_version !== '0.5') {
    check(ordinaryRoots === c.expected_totals.non_boss_root_monsters && ordinaryEnergy === c.expected_totals.non_boss_energy_budget && bossEnergy === c.expected_totals.boss_energy_budget, '普通/Boss总预算');
  }
  if (hasBossStages) {
    const mini = monsters.get('B002'), major = monsters.get('B001');
    check(mini?.boss_tier === 'mini' && mini.ui_title === '小Boss' && mini.hp_by_wave && mini.control_class === 'boss' && mini.reward_energy === 200, '小Boss定义');
    check(major?.boss_tier === 'major' && major.ui_title === '大Boss' && major.control_class === 'boss' && major.reward_energy === 200 && !major.hp_by_wave, '大Boss定义');
    check(bossRoots === 4 && c.expected_totals.boss_root_monsters === bossRoots, '四次Boss总量');
  }
  for (const id of c.card_draw.unlimited_common_ids) {
    const card = c.cards.find((v: any) => v.id === id);
    check(card && card.max_picks === null && card.eligibility.always, '三张无限兜底');
  }
  for (const card of c.cards) {
    if (card.effects.unlock_skill) check(ids('skills').has(card.effects.unlock_skill), '卡牌技能引用');
    for (const rule of card.eligibility.any || []) {
      if (rule.roster_contains) check(ids('heroes').has(rule.roster_contains), '卡牌英雄引用');
      if (rule.skill_unlocked) check(ids('skills').has(rule.skill_unlocked), '卡牌条件技能引用');
    }
  }
}

export function nextRandom(value: number): number {
  let n = value >>> 0; n ^= n << 13; n ^= n >>> 17; n ^= n << 5;
  return n >>> 0;
}
export function eligibleCards(config: any, roster: string[], stacks: Record<string, number>, skills: Record<string, unknown>): any[] {
  return config.cards.filter((c: any) => (c.max_picks === null || (stacks[c.id] || 0) < c.max_picks)
    && (c.eligibility.always || c.eligibility.any?.some((r: any) =>
      r.roster_contains ? roster.includes(r.roster_contains) : !!skills[r.skill_unlocked]))).sort((a: any, b: any) => a.id.localeCompare(b.id));
}
export function drawCards(config: any, roster: string[], stacks: Record<string, number>, skills: Record<string, unknown>, rng: number): { ids: string[]; rng: number } {
  const pool = eligibleCards(config, roster, stacks, skills).map(c => c.id);
  if (pool.length < config.card_draw.count) throw new Error('有效卡池不足，拒绝伪造候选');
  for (let i = pool.length - 1; i > 0; i--) {
    rng = nextRandom(rng); const j = rng % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return { ids: pool.slice(0, config.card_draw.count), rng };
}
