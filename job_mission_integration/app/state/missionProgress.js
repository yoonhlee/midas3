const DIFFICULTY_ORDER = { easy: 0, normal: 1, hard: 2 };

function difficultyRank(mission) {
  const level = mission?._raw?.mission?.difficulty?.level || mission?.difficulty?.level || mission?.difficulty;
  return DIFFICULTY_ORDER[level] ?? DIFFICULTY_ORDER.normal;
}

export function getMissionsByJobCode(allMissions, jobCode) {
  return allMissions
    .map((mission, index) => ({ mission, index }))
    .filter(({ mission }) => mission.job_code === jobCode)
    .sort((a, b) => difficultyRank(a.mission) - difficultyRank(b.mission) || a.index - b.index)
    .map(({ mission }) => mission);
}

export function getCurrentMission({ allMissions, state }) {
  const jobCode = state.selectedJobs[state.missionJobIndex];
  return getMissionsByJobCode(allMissions, jobCode)[state.missionStepIndex] || null;
}

export function getTotalMissionCount({ allMissions, selectedJobs }) {
  return selectedJobs.reduce((sum, jobCode) => sum + getMissionsByJobCode(allMissions, jobCode).length, 0);
}

export function getDoneMissionCount({ allMissions, state }) {
  let done = 0;
  for (let idx = 0; idx < state.missionJobIndex; idx += 1) {
    done += getMissionsByJobCode(allMissions, state.selectedJobs[idx]).length;
  }
  return done + state.missionStepIndex;
}

export function isLastMission({ allMissions, state }) {
  const jobCode = state.selectedJobs[state.missionJobIndex];
  const missions = getMissionsByJobCode(allMissions, jobCode);
  return state.missionJobIndex === state.selectedJobs.length - 1
    && state.missionStepIndex === missions.length - 1;
}
