(function (root) {
  'use strict';
  const spectatorEffects = {
    glass: ['敲玻璃', '◎'], tomato: ['番茄', '🍅'], confetti: ['彩纸', '🎉'],
    hand: ['手印', '✋'], firework: ['烟花', '✦'],
  };
  const attacks = {
    manual: ['手动点名', '默认攻击房间顺序的前一位，首位选末位；点击棋盘可更换，跳过淘汰者和队友。'],
    random: ['随机攻击', '每次消行随机选择一名对手，整包发送。'],
    lowest: ['累计消行最少', '攻击累计消行最少的对手，并列随机。会让落后者更难翻盘。'],
    leader: ['追击领跑者', '攻击累计消行最多的对手，并列随机。'],
    emptiest: ['攻击最空棋盘', '攻击当前堆叠最低的对手，与累计消行数无关。'],
    highest: ['趁危追击', '攻击当前堆叠最高的对手，快速淘汰。'],
    round: ['轮流攻击', '按加入顺序轮流攻击，每次有效攻击换人。'],
    split: ['分散轰炸', '逐行轮流分给对手，总发出行数不变。'],
    all: ['全场震荡', '每位存活对手各收到完整攻击量，总量随人数放大。'],
    bounty: ['悬赏目标', '每 20 秒轮换公共目标；目标自己或目标是队友时随机攻击敌方。'],
  };
  const modes = {
    survival: ['经典生存', '最后存活的玩家获胜。'],
    timed: ['限时竞赛', '时间到后存活者优先，再比较消行和分数；完全并列共享名次。'],
    sprint: ['消行竞速', '首个达到目标行数且未淘汰的玩家获胜，也可通过最后存活获胜。'],
    teams: ['团队对抗', '红蓝两队人数相等，只攻击敌方，最后有存活成员的队伍获胜。'],
    battle: ['绝地求生', '每 30 秒全员额外收到一行可抵消的环境垃圾，最后存活者获胜。'],
    practice: ['和平练习', '无玩家攻击，可单人开局；所有人淘汰或房主结束时结算。'],
    dig: ['挖掘挑战', '同样的障碍开局，先挖干净者获胜；无攻击、无净化，可单人挑战。'],
    coop: ['合作守城', '全员合作抵御障碍波次，消行先自保再帮助队友；末波后坚持 20 秒过关。'],
  };
  const toggles = {
    packetHole: ['同包同缺口', '同一包障碍共用缺口，更容易挖掘；关闭后逐行随机。'],
    counter: ['攻击抵消', '消行攻击先抵消待接收垃圾，剩余才发给对手。'],
    combo: ['连击奖励', '连续消行从第二次起奖励 1 行，最多额外 3 行；未消行重置。'],
    buffer: ['垃圾缓冲', '攻击到达至少 2 秒后，才在锁定方块时加入。'],
    cooldown: ['目标冷却', '手动切换目标后 3 秒内不能再换。'],
    digBonus: ['挖掘奖励', '每正常清除一条含灰色障碍的行，再抵消一行待接收垃圾，不额外攻击。'],
    cleanse: ['能量净化', '实际消行积攒能量，6 点可在下次锁定净化最多两条障碍行。'],
  };
  const defaults = Object.freeze({
    mode: 'survival', attack: 'round', duration: 180, goal: 40, digRows: 8, waves: 5, packetHole: true,
    counter: true, combo: false, buffer: true, cooldown: false, digBonus: false, cleanse: true,
  });
  const presets = {
    friends: { name: '好友乱斗', settings: { ...defaults, attack: 'random' } },
    duel: { name: '点名对决', settings: { ...defaults, attack: 'manual' } },
    timed: { name: '三分钟挑战', settings: { ...defaults, mode: 'timed' } },
    sprint: { name: '消行竞速', settings: { ...defaults, mode: 'sprint' } },
    teams: { name: '团队对抗', settings: { ...defaults, mode: 'teams' } },
    battle: { name: '极限生存', settings: { ...defaults, mode: 'battle' } },
    dig: { name: '挖掘挑战', settings: { ...defaults, mode: 'dig', cleanse: false, counter: false } },
    coop: { name: '合作守城', settings: { ...defaults, mode: 'coop', counter: true } },
    practice: { name: '自由练习', settings: { ...defaults, mode: 'practice' } },
  };
  function hostile(settings) { return !['practice', 'dig', 'coop'].includes(settings.mode); }
  function previousOpponent(players, playerId, settings) {
    if (!hostile(settings)) return null;
    const index = players.findIndex(player => player.id === playerId);
    if (index < 0) return null;
    const self = players[index];
    for (let offset = 1; offset < players.length; offset++) {
      const candidate = players[(index - offset + players.length) % players.length];
      if (candidate.game?.alive && (settings.mode !== 'teams' || candidate.team !== self.team)) return candidate;
    }
    return null;
  }
  function normalize(settings) {
    const result = { ...settings };
    if (result.mode === 'dig') { result.cleanse = false; result.combo = false; result.counter = false; result.digBonus = false; }
    if (result.mode === 'coop') result.counter = true;
    return result;
  }
  function summary(settings) {
    let goal = modes[settings.mode][1];
    if (settings.mode === 'dig') goal = `先清除开局 ${settings.digRows} 行障碍；无攻击、无净化。`;
    if (settings.mode === 'coop') goal = `全员顶住 ${settings.waves} 波，末波后坚持 20 秒过关。`;
    if (settings.mode === 'sprint') goal = `率先消除 ${settings.goal} 行，或成为最后存活者。`;
    if (settings.mode === 'timed') goal = `${settings.duration / 60} 分钟内比消行，存活者优先，同消行比分数。`;
    const behavior = settings.mode === 'coop' ? '消行先自保，余量自动救援队友' : hostile(settings) ? attacks[settings.attack][0] : '无玩家攻击';
    const defense = [behavior];
    if (hostile(settings) && settings.counter) defense.push('抵消开启');
    if ((hostile(settings) || settings.mode === 'coop') && settings.buffer) defense.push('2 秒缓冲');
    if (settings.cleanse && settings.mode !== 'dig') defense.push('6 能量净化');
    return [goal, defense.join(' · ')];
  }
  function validate(current, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) return null;
    const result = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(defaults, key)) return null;
      if (Object.hasOwn(toggles, key)) { if (typeof value !== 'boolean') return null; }
      else if (key === 'mode') { if (typeof value !== 'string' || !Object.hasOwn(modes, value)) return null; }
      else if (key === 'attack') { if (typeof value !== 'string' || !Object.hasOwn(attacks, value)) return null; }
      else if (key === 'duration') { if (![60, 180, 300].includes(value)) return null; }
      else if (key === 'goal') { if (![20, 40, 80].includes(value)) return null; }
      else if (key === 'digRows') { if (![4, 8, 12].includes(value)) return null; }
      else if (key === 'waves') { if (![3, 5, 8].includes(value)) return null; }
      result[key] = value;
    }
    return normalize(result);
  }
  const rules = { spectatorEffects, attacks, modes, toggles, defaults, presets, hostile, previousOpponent, normalize, summary, validate };
  if (typeof module !== 'undefined' && module.exports) module.exports = rules;
  else root.BlockRules = rules;
})(typeof globalThis !== 'undefined' ? globalThis : this);
