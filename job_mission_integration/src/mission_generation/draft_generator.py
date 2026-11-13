# LLM 입력 패키지를 prompt/API/mock draft 생성 흐름으로 변환한다.

from __future__ import annotations

import copy
import json
import re
from typing import Any

from .blueprint_checker import korean_length_hint, parse_length_range
from .blueprint_designer import TWO_STAGE_HARD_ANSWER_LENGTH
from .config import RuntimeConfig
from .llm_runtime import create_runtime

# 두 단계 생성(설계서 → 미션 작성)에서 미션 작성 프롬프트의 버전. 근거 기록에 남긴다.
# v2: 맞지 않는 용어는 빼고, 자료 안에 답을 알려 주는 메모를 쓰지 않는다.
# v3: 과제 지시문과 자료 쓰임이 틀린 칸이나 답이 되는 행을 직접 짚지 않는다.
# v4: 보통 난이도에 판단 한 단계를 요구한다(BLUEPRINT_NORMAL_REQUIREMENTS).
# v5: 자료 형태 여덟 가지를 모두 쓴다. 체크리스트 표시와 카드의 세 값이 답을 알려 주지 않게 하고,
#   화면에 보이지 않는 값(차트 단위, 메모 작성자)을 제목·설명에 적게 한다. 쉬움 난이도 규칙을 더했다.
# v6: 두 단계 생성에서 카드를 뺐으므로 카드의 세 값 규칙을 지운다.
# v7: 어려움 난이도의 답 분량을 과제마다 3~5문장으로 늘린다(blueprint-v9와 함께).
# v8: 채점 기준은 지시문이 쓰라고 한 것만 본다. 분량은 지시문·유의 사항·제출 형식에서 같은 말("N~M문장")로 쓴다.
#   용어 풀이는 뜻만 적고, 상황·목표 문장에 정답의 이름을 미리 쓰지 않는다. 보통은 3~4문장에 뺀 후보 하나의 이유까지 쓴다
#   (blueprint-v10과 함께). 검수에서 되풀이된 지적을 막는다.
# v9: 보통의 "맞아 보이지만 답이 아닌 것 하나를 설명하라" 요구와 3~4문장을 되돌린다(blueprint-v11과 함께).
#   보통도 그럴듯한 오답은 자료에 두되 채점하지 않고, 답 분량은 2~3문장이다. v8의 나머지 규칙은 그대로다.
# v10: 어려움 과제 2의 채점은 추천이 과제 1의 결과에서 나오는지, 이유와 주의점이 자료에 묶여 있는지를 본다.
#   자료가 하나만 허용할 때만 기대 추천을 정하고, 아니면 근거가 맞는 추천은 모두 만점이다(예시는 '예시:'·'예:'로만).
#   어려움의 분량이 과제마다라는 것을 지시문("3~5문장")과 유의 사항·제출 형식("과제마다 3~5문장")에 밝힌다(blueprint-v12와 함께).
# v11: 과제 2 문장을 모양을 가리키지 않는 원칙으로 바꾼다(blueprint-v13과 함께). 자료가 답을 하나로 정하지 않는 곳에서는
#   특정 답을 요구하지 않고, 이유가 학습자 자신의 선택을 자료의 다른 선택지와 견줘 받치는지를 채점한다. 사실만 맞고 선택을 받치지
#   못하는 이유는 부분 점수다. 지시문이 무엇을 정하라는지 분명히 하라는 뜻만 남기고 모양 예시는 뺐다. 분량 줄은 v10 그대로다.
WRITER_PROMPT_VERSION = "blueprint-writer-v11"

# 설계서가 있을 때 공통 규칙 뒤에 붙이는 작성 규칙. 설계서가 가리킨 원문(cited_sources)만 근거로 쓰게 한다.
BLUEPRINT_REQUIREMENTS = (
    "\nBlueprint requirements:\n"
    "- mission_blueprint holds the design decisions for this mission. Follow them exactly and do not add new source material.\n"
    "- cited_sources holds the only source text you may use. It is real job data (KNOW) and a national competency standard for this job.\n"
    "- The i-th mission material follows mission_blueprint.materials with slot i (type, role, content_plan). The i-th task follows mission_blueprint.tasks with slot i.\n"
    "- Use each borrowed_terms term of a material exactly as written, inside that material, as the name of something the material really shows. If a term does not fit what the material shows, leave that term out instead of forcing it into a title, label, or description.\n"
    "- Materials are workplace documents and data, not hints. No material title, description, cell, note, or remark may say which entry is wrong, missing, or different, why a mistake was made, which option is the answer, or what conclusion to draw. Give facts, figures, conditions, definitions, and calculation rules; the learner does the comparing, choosing, and concluding.\n"
    "- When a table needs a remarks column, fill it with neutral facts such as unit, date, source, or status. material.description says what the material is, not what to notice in it.\n"
    "- The same holds for the marks and labels the screen shows. A checklist item's status is the tick the form already carries: use checked or unchecked only, never issue, and never set a status to point at the item the learner has to find. importance is \"high\" for an item the document itself stresses and \"normal\" otherwise.\n"
    "- Write for what the screen shows. A chart shows its values, x labels, and series names but not its axis labels or unit, so put the unit in the chart's title or description. A memo shows its items but not its author, so name the source document or writer in the memo's title or description. An email shows sender, recipient, subject, and body; write the body in the sender's own words. A log lists its entries in time order.\n"
    "- Task instructions and material.used_for say what to do with the materials. They do not name the entry that is wrong or the row, field, or value that is the answer.\n"
    "- mission.title, mission.scenario.context, and mission.scenario.goal set up the situation and the request. They do not name the answer before the learner works it out: "
    "no option, method, entry, or value that turns out to be the right one, even when the target sentence in cited_sources uses that word. Describe the work in general words there and let the materials show the options.\n"
    "- Add every mission_blueprint.glossary_terms term to mission.scenario.glossary with a short plain-Korean definition. "
    "A definition says only what the term means. It does not contain this mission's decision rule, threshold, formula, worked example, or answer; "
    "put a rule or formula the learner needs in a material or in the scenario as a workplace fact. "
    "When you narrow the meaning to how this mission uses the term, begin that part with '이 미션에서는'.\n"
    "- Build evaluation.expected_insights and evaluation.rubric from mission_blueprint.evaluation_basis. Fill basis_map.rubric with one entry per rubric item: rubric_index is the item's position from 0, evaluation_basis_index is the position from 0 of the evaluation_basis item it comes from.\n"
    "- Each evaluation.rubric item grades only a part of the answer that a task instruction explicitly asks the learner to write. "
    "Do not grade a structure or grouping the instruction does not ask for (for example, explaining software conditions and hardware conditions separately when the task asks only for the choice and its reason), "
    "an extra observation, or why other options were ruled out unless the instruction asks for it. "
    "If an evaluation_basis item would grade something the instructions do not ask for, leave it out of the rubric instead of adding a new demand to the task. "
    "expected_insights may still note why other options are wrong, as background for graders.\n"
    "- State the answer length the same way everywhere. mission.submission_format.length_hint is the range of system_decisions.difficulty.answer_length_hint written in Korean as 'N~M문장' "
    "(for example '1-2 short sentences' becomes '1~2문장', '3-5 short sentences per task' becomes '과제마다 3~5문장'), never in English. "
    "When a task instruction or mission.scenario.constraints mention the length, use the same words as length_hint for the whole answer; do not give a different count such as '한 문장으로', and do not give separate counts for parts of the answer.\n"
    "- mission.submission_format.estimated_time_minutes is system_decisions.difficulty.estimated_time_minutes.\n"
    "- Use only the evidence names listed in schema_constraints.material_rules.allowed_evidence_names for evidence_source and linked_evidence.\n"
    "- schema_constraints and system_decisions always have higher priority. Keep the current difficulty policy exactly, including material count and task count.\n"
    "- Every task must be answerable from the provided materials.\n"
    "- Do not expose piece ids, or the words NCS, 능력단위, 수행준거, in learner-facing mission text.\n"
)

# 쉬움 난이도는 자료가 하나다. 적용할 조건 하나는 상황 글에 두고, 한 번 적용해 나오는 발견이나 선택만 묻는다.
BLUEPRINT_EASY_REQUIREMENTS = (
    "\nBlueprint easy-level requirements (these refine the general easy-difficulty rule above; the counts stay the same):\n"
    "- Keep exactly 1 material, exactly 1 task, and a 1-2 sentence answer.\n"
    "- The material carries every fact needed. State the one condition, rule, or request the learner applies in mission.scenario (context, goal, or constraints), as a workplace fact or in the requester's words, not as a hint.\n"
    "- The answer is one finding or one choice that follows from applying that condition to the material once. No chain of steps, and no arithmetic beyond one comparison.\n"
    "- The task asks for that finding or choice and its reason, and the rubric grades only those. Entries that look like the answer may stay in the material, but no rubric item grades why they were ruled out.\n"
)

# 보통 난이도에서 공통 규칙의 "단순한 비교 하나"를 구체화한다. 개수(자료 2개, 과제 1개)는 그대로 두고,
# 값 옮겨 적기나 틀린 칸 하나 찾기로 끝나지 않게 판단 한 단계를 요구한다. 두 단계 생성에서만 쓴다.
BLUEPRINT_NORMAL_REQUIREMENTS = (
    "\nBlueprint normal-level requirements (these refine the general normal-difficulty rule above; the counts stay the same):\n"
    "- Keep exactly 2 materials, exactly 1 task, and a 2-3 sentence answer.\n"
    "- The task needs one real step of judgment: the learner takes a condition, rule, request, or small calculation from one material and applies it to what the other shows, and needs both materials to reach the answer.\n"
    "- Keep the tempting wrong answer that mission_blueprint plans (a candidate, entry, or reading that fits some conditions but not all). Do not remove it, mark it, or make the right answer the only one that fits at first glance.\n"
    "- The task instruction asks for the answer (the choice, the entries found, or the value worked out) and its reason, and the rubric grades only those. "
    "No rubric item grades why the tempting wrong answer or another option is ruled out. When the instruction asks for a verdict on each entry, those verdicts are part of the answer and may be graded.\n"
    "- Do not reduce the task to copying values into blanks, reading off one value, or spotting a single mismatched entry.\n"
    "- Give the facts and domain rules a newcomer cannot know, such as how an amount is defined or which rate applies when. Do not walk the learner through the steps in the task instruction, constraints, or material descriptions.\n"
    "- The expected answer must be the only one that satisfies every condition in the materials. Check each candidate, entry, or reading against every condition before you finish.\n"
)

# 어려움의 분량은 과제마다다(blueprint_designer.TWO_STAGE_HARD_ANSWER_LENGTH). 규칙 글의 숫자를 그 값에서 만든다.
_HARD_LOW, _HARD_HIGH = parse_length_range(TWO_STAGE_HARD_ANSWER_LENGTH)
_HARD_LENGTH_HINT = korean_length_hint(TWO_STAGE_HARD_ANSWER_LENGTH)  # "과제마다 3~5문장"

# 어려움 난이도에서만 초보자 규칙을 푼다(NCS 모드의 완화와 같은 취지). 근거는 cited_sources에서만 가져온다.
# v10: 분량이 과제마다라는 것을 세 곳(지시문, 유의 사항, 제출 형식)에 같은 말로 쓰게 하고, 과제 2의 채점을 열어 둔다.
# v11: 과제 2의 채점 문장을 모양을 가리키지 않는 원칙(이유가 선택을 다른 선택지와 견줘 받치는가)으로 바꿨다.
BLUEPRINT_HARD_OVERRIDES = (
    "\nBlueprint hard-level overrides (these replace the general hard-difficulty, one-action, and everyday-words rules above):\n"
    "- Use exactly 3 materials and exactly 2 tasks, as system_decisions.difficulty says.\n"
    f"- The answer length is per task: each task's answer is {_HARD_LOW}-{_HARD_HIGH} short sentences, and mission.submission_format.length_hint is '{_HARD_LENGTH_HINT}'. "
    f"A task instruction that mentions the length says '{_HARD_LOW}~{_HARD_HIGH}문장' for that task, and constraints that mention it say '{_HARD_LENGTH_HINT}'; "
    "never give one count for both tasks together. The mission must still be solvable by a newcomer who reads the materials and glossary carefully.\n"
    "- Use the job's real working terms from cited_sources where they fit, and define each one in mission.scenario.glossary.\n"
    "- Give every criterion, weight, target, and number needed inside the materials, and keep any arithmetic to small sums or simple comparisons.\n"
    "- For table materials, keep the required option, strength, weakness, priority keys and put criteria or scores inside the cell text when needed.\n"
    "- The task 2 instruction says plainly what the learner is to decide, as mission_blueprint.tasks says, so learners and graders read it the same way.\n"
    "- Where the materials do not settle one right answer, the rubric does not require a particular answer. "
    "It grades whether the learner's reason, drawn from the task 1 result and the materials, actually supports the learner's own choice when set against the other options the materials show. "
    "A reason that states true facts from the materials but does not show why that choice holds up better than the others earns only part of the points, not full points. "
    "Name a single expected answer in the rubric only when the materials allow no other. "
    "A caution earns its points when it is a real risk or limit of the chosen course that the materials show. "
    "evaluation.expected_insights may describe one answer and caution as an example, beginning with '예시:', and a rubric description may mention it only after '예:'; "
    "no rubric item treats the example as the only accepted answer.\n"
)


class LLMInputPackageBuilder:
    """profile, system decisions, schema, optional background를 하나의 생성 입력으로 묶는다."""

    def build(
        self,
        job_profile: dict[str, Any],
        system_decisions: dict[str, Any],
        schema_constraints: dict[str, Any],
        job_practice_profile_excerpt: dict[str, Any] | None = None,
        mission_seed: dict[str, Any] | None = None,
        job_practice_sheet_background: dict[str, Any] | None = None,
        job_ncs_background: dict[str, Any] | None = None,
        mission_blueprint: dict[str, Any] | None = None,
        cited_sources: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """미션 생성 LLM이 받는 최종 입력 JSON 패키지를 구성한다.

        mission_blueprint와 cited_sources는 두 단계 생성에서만 준다(설계서와 설계서가 가리킨 원문 조각).
        """

        package = {
            "schema_version": "llm_input_package.v1",
            "job_profile": job_profile,
            "system_decisions": system_decisions,
            "schema_constraints": schema_constraints,
        }
        if job_practice_profile_excerpt is not None:
            package["job_practice_profile_excerpt"] = job_practice_profile_excerpt
        if mission_seed is not None:
            package["mission_seed"] = mission_seed
        if job_practice_sheet_background is not None:
            package["job_practice_sheet_background"] = job_practice_sheet_background
        if job_ncs_background is not None:
            package["job_ncs_background"] = job_ncs_background
        if mission_blueprint is not None:
            package["mission_blueprint"] = mission_blueprint
        if cited_sources is not None:
            package["cited_sources"] = cited_sources
        return package


class MissionDraftGenerator:
    """llm_input_package를 실제 LLM 호출 또는 명시적으로 허용된 mock draft 경로로 넘긴다."""

    def __init__(
        self,
        runtime: Any = None,
        allow_mock_without_key: bool = False,
        force_mock: bool = False,
    ) -> None:
        # 제공자(Claude 기본, GPT 선택)에 맞는 호출부를 쓴다.
        self.runtime = runtime or create_runtime()
        self.allow_mock_without_key = allow_mock_without_key
        self.force_mock = force_mock

    def generate(self, llm_input_package: dict[str, Any]) -> dict[str, Any]:
        """기본은 실제 LLM을 사용하고, 옵션으로 허용된 경우에만 mock draft를 생성한다."""

        config = self.runtime.config
        if self.force_mock or (not self.runtime.api_key_available() and self.allow_mock_without_key):
            draft = MockMissionDraftBuilder().build(llm_input_package)
            return {
                "llm_call_result": self._mock_call_result("draft_generation", config, draft, config.draft_temperature),
                "mission_draft": draft,
            }

        prompts = PromptBuilder().draft_prompts(llm_input_package)
        call_result = self.runtime.call_structured(
            call_type="draft_generation",
            system_prompt=prompts["system"],
            user_prompt=prompts["user"],
            json_schema=llm_input_package["schema_constraints"]["structured_output_schema"],
            temperature=config.draft_temperature,
            max_output_tokens=config.max_output_tokens_draft,
        )
        return {"llm_call_result": call_result, "mission_draft": call_result.get("output_json")}

    def _mock_call_result(
        self,
        call_type: str,
        config: RuntimeConfig,
        draft: dict[str, Any],
        temperature: float,
    ) -> dict[str, Any]:
        """mock draft도 실제 LLM call_result와 같은 메타데이터 모양으로 감싼다."""

        return {
            "schema_version": "llm_call_result.v1",
            "provider": "mock",
            "api": "local_dry_run",
            "model": config.model,
            "call_type": call_type,
            "reasoning_effort": config.reasoning_effort,
            "configured_temperature": temperature,
            "temperature_request_parameter": config.temperature_application()["request_parameter"],
            "temperature_applied": False,
            "temperature_omitted_reason": "mock_generation",
            "temperature_retry_without_parameter": False,
            "status": "mocked",
            "output_json": draft,
            "usage": {"input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0, "total_tokens": 0},
            "errors": [],
            "attempt_count": 1,
            "retry_count": 0,
            "retry_errors": [],
        }


class PromptBuilder:
    """저장용 입력 패키지에서 prompt 본문에 넣을 지침과 JSON payload를 만든다."""

    def draft_prompts(self, llm_input_package: dict[str, Any]) -> dict[str, str]:
        """mission_seed/background 사용 여부에 맞춰 draft 생성 prompt를 만든다."""

        practice_requirements = ""
        if llm_input_package.get("mission_blueprint"):
            # 두 단계 생성: 설계서의 결정과 설계서가 가리킨 원문만으로 미션을 쓴다.
            practice_requirements = BLUEPRINT_REQUIREMENTS
            level = llm_input_package["system_decisions"]["difficulty"]["level"]
            if level == "hard":
                practice_requirements += BLUEPRINT_HARD_OVERRIDES
            elif level == "normal":
                practice_requirements += BLUEPRINT_NORMAL_REQUIREMENTS
            elif level == "easy":
                practice_requirements += BLUEPRINT_EASY_REQUIREMENTS
        elif llm_input_package.get("mission_seed"):
            practice_requirements = (
                "\nPractice survey requirements:\n"
                "- Use mission_seed as the main design brief for scenario, materials, tasks, submission format, and evaluation.\n"
                "- Keep system_decisions and schema_constraints higher priority than mission_seed when they conflict.\n"
                "- For normal difficulty with mission_seed, create exactly 2 learner-visible materials: one primary material and one supporting material.\n"
                "- Derive those materials from mission_seed.material_blueprints while staying within system_decisions.allowed_material_types.\n"
                "- If mission_seed.scenario_basis.request_sentence is empty, do not create a direct quoted request sentence.\n"
                "- Reflect guide_plan through the single mission.tasks instruction and mission.submission_format.required_sections; do not create a mission.guide field.\n"
                "- The task must require the learner to inspect and connect at least two provided materials.\n"
                "- Evaluation must be based on mission_seed.evaluation_basis and the selected decision situation.\n"
                "- Do not expose source_refs to the learner-facing mission text.\n"
                "- If a table uses a priority column, use it only as a comparison clue, not as a final answer or recommendation.\n"
            )
        elif llm_input_package.get("job_ncs_background"):
            # 배경으로만 쓰는 조사시트와 달리, NCS 능력단위는 과제·자료·채점의 설계 근거로 쓴다.
            practice_requirements = (
                "\nNCS background requirements:\n"
                "- job_ncs_background is a real national competency standard (NCS) unit for this job, and system_decisions.mission_design comes from it.\n"
                "- Build the mission around exactly one performance criterion from job_ncs_background.elements[].performance_criteria that a beginner can try in one short task at this difficulty.\n"
                "- Turn that criterion into one concrete workplace request inside the scenario. Do not copy the criterion sentence into learner-facing text.\n"
                "- Make the materials look like the workplace documents listed in job_ncs_background.documents, expressed with system_decisions.allowed_material_types.\n"
                "- Use job_ncs_background.considerations to choose realistic details such as indicators, criteria, and items to compare, and put every number or fact the learner needs inside the materials.\n"
                "- Use the job's real terms where they are natural, and add each one with a short plain-Korean definition to mission.scenario.glossary.\n"
                "- Base evaluation.expected_insights and evaluation.rubric on the chosen performance criterion and job_ncs_background.eval_considerations, simplified to what the materials support.\n"
                "- schema_constraints and system_decisions always have higher priority than job_ncs_background. Keep the current difficulty policy exactly, including material count and task count.\n"
                "- Every task must be answerable from the provided materials; do not require outside NCS knowledge.\n"
                "- Do not expose the words NCS, 능력단위, 수행준거, or any code from job_ncs_background in learner-facing mission text.\n"
            )
            if llm_input_package["system_decisions"]["difficulty"]["level"] == "hard":
                # hard만 초보자 규칙을 풀어 직무 용어와 2단계 과제를 허용한다(실험). easy·normal은 그대로 둔다.
                practice_requirements += (
                    "\nNCS hard-level overrides (these replace the general hard-difficulty, one-action, and everyday-words rules above):\n"
                    "- Use exactly 3 materials and exactly 2 tasks, as system_decisions.difficulty says.\n"
                    "- Task 1 applies the working method of the chosen performance criterion to the materials, for example scoring candidates against given criteria and weights, or comparing indicators with targets. Give every criterion, weight, target, and number needed inside the materials, and keep any arithmetic to small sums or simple comparisons.\n"
                    "- Task 2 uses the result of task 1 to make one recommendation or decision for the requester, with one caution or trade-off visible in the materials.\n"
                    "- Use the job's real working terms and indicators from job_ncs_background.considerations and job_ncs_background.eval_considerations (for example sales, market share, screening criteria, weights, feasibility) where they fit, and define each one in mission.scenario.glossary.\n"
                    "- Make the materials read like the real documents in job_ncs_background.documents, with document-like titles and realistic figures, not like casual notes.\n"
                    "- For table materials, keep the required option, strength, weakness, priority keys and put criteria or scores inside the cell text when needed.\n"
                    "- Each task may ask for 2-4 short sentences. The mission must still be solvable by a newcomer who reads the materials and glossary carefully.\n"
                )
            if llm_input_package.get("schema_constraints", {}).get("ncs_basis_required"):
                # 사용 근거 기록(실험): 미션이 실제로 쓴 수행준거를 남긴다. 켜지 않으면 프롬프트는 그대로다.
                practice_requirements += (
                    "\nNCS traceability requirement:\n"
                    "- Fill ncs_basis. unit_name is job_ncs_background.competency_unit.name.\n"
                    "- ncs_basis.performance_criteria lists the one or two criteria you actually built the tasks, materials, and rubric around. Copy each text exactly as written in job_ncs_background.elements[].performance_criteria and put that element's name in element_name.\n"
                    "- ncs_basis.how_used is one Korean sentence on how the chosen criterion shaped the task, materials, and rubric.\n"
                    "- ncs_basis is for traceability only. Its contents must not appear in learner-facing mission text.\n"
                )
        elif llm_input_package.get("job_practice_sheet_background"):
            practice_requirements = (
                "\nPractice sheet background requirements:\n"
                "- Use job_practice_sheet_background only as background context to make the mission more realistic.\n"
                "- schema_constraints and system_decisions always have higher priority than job_practice_sheet_background.\n"
                "- Keep the current difficulty policy exactly, including material count and task count.\n"
                "- Do not expose source ids, source_refs, URLs, Markdown headings, or original research notes in learner-facing mission text.\n"
                "- Do not turn background context into an external-knowledge question; every task must be answerable from the provided mission materials.\n"
                "- Do not create or reference mission_seed when job_practice_sheet_background is used without mission_seed.\n"
            )
        prompt_input_package = self._prompt_input_package(llm_input_package)
        system_prompt = (
            "너는 직업 데이터 기반 미션 초안을 작성하는 작성자다. "
            "미션의 목적은 전문가 평가가 아니라 사전 전문지식 없이 직업의 사고방식을 짧게 체험하게 하는 것이다. "
            "시스템이 지정한 selected_exec_job, task_type, difficulty, allowed_material_types를 변경하지 않는다. "
            "mission_output.v1 형식의 JSON만 출력한다. "
            "실제 기업명, 실제 브랜드명, 실제 인명, 외부 검색이나 전문 자격 지식이 필요한 과제는 만들지 않는다. "
            "reliability는 {\"status\":\"pending_validation\"}만 출력하고 evidence_chain은 만들지 않는다."
        )
        user_prompt = (
            "다음 llm_input_package를 바탕으로 mission_output.v1 초안을 생성하라.\n"
            "JSON만 출력하고 Markdown 코드블록을 사용하지 마라.\n"
            "mission_id는 \"draft\"로 둔다.\n"
            "target_exec_job, mission.task_type, mission.secondary_task_types, mission.difficulty는 system_decisions 값을 복사한다.\n"
            "materials는 system_decisions.allowed_material_types 안에서만 생성한다.\n"
            "모든 material은 factual_status, evidence_source, mission_fact_refs를 가진다.\n"
            "reliability는 {\"status\":\"pending_validation\"}만 출력한다.\n\n"
            "Return one complete valid JSON object.\n"
            "Do not truncate the JSON.\n"
            "Do not include comments, trailing commas, Markdown, or text outside JSON.\n"
            "Ensure all strings are properly closed and escaped.\n\n"
            "Use system_decisions.mission_design as the design intent for the mission.\n"
            "Reflect mission_design_type and design_intent when creating scenario, materials, tasks, and evaluation.\n"
            "Do not copy mission_design into mission_output.\n\n"
            "Quality requirements:\n"
            "- Write all user-facing mission text in natural Korean.\n"
            "- Make the scenario concrete and workplace-like, but use only synthetic organizations, products, customers, and data.\n"
            "- mission.scenario.glossary is required. Use an empty array when no glossary is needed.\n"
            "- Put learner-facing term explanations only in mission.scenario.glossary as {\"term\":\"...\",\"definition\":\"...\"}; do not append '용어 설명:' notes to scenario.context, scenario.goal, constraints, tasks, or material text.\n"
            "- Reflect system_decisions.mission_design.mission_design_type and design_intent in the scenario, materials, tasks, and evaluation.\n"
            "- Make every material useful for solving at least one task. Avoid decorative or unrelated materials.\n"
            "- Make task instructions clear about what the learner must notice, choose, compare, explain, or suggest.\n"
            "- Make the mission easier than a real workplace task.\n"
            "- The learner should only need to notice, choose, compare, or explain a simple thing from the provided materials.\n"
            "- Avoid legal, financial, technical, policy, compliance, or expert judgment unless the material explains it in beginner terms.\n"
            "- Prefer everyday workplace words over specialist terms.\n"
            "- For easy difficulty, use exactly 1 material and exactly 1 task. The answer should be 1-2 short sentences. Ask the learner to identify one obvious issue, choose one option, or explain one visible pattern. Do not ask for root-cause analysis, risk assessment, prioritization, or trade-off judgment.\n"
            "- For normal difficulty, use exactly 2 materials and exactly 1 task. The task should ask for one simple comparison or one simple recommendation. The answer should be 2-3 short sentences. Do not ask for full diagnosis.\n"
            "- For hard difficulty, use exactly 3 materials and exactly 1 task. Hard means more materials, not expert-level reasoning. Ask for one short decision response that includes one visible caution. The answer should be 3-5 short sentences. All clues must be visible in the materials.\n"
            "- Every task must require only one learner action or deliverable. Do not combine multiple actions such as find + compare + choose + write in one task.\n"
            "- Make every task answerable as a short descriptive written response, not as a code-only, letter-only, number-only, or single-word answer.\n"
            "- If a learner must choose an option, the single deliverable should be one sentence or short paragraph that includes the choice and reason.\n"
            "- Keep the mission answerable only from the provided materials and mission facts.\n"
            "- Avoid generic textbook wording, vague business jargon, and repeated template-like sentences.\n"
            "- Do not copy mission_design into mission_output.\n\n"
            "Job-experience style requirements:\n"
            "- Model the learner-facing tone after docx/직무미션_ref.html: short, direct, and experience-oriented.\n"
            "- Treat the learner as a beginner, intern, assistant, or new team member trying the job for the first time.\n"
            "- Prefer simple Korean prompts such as '당신은 ... 인턴입니다', '아래 자료를 보고 ... 해보세요', and '이유를 적어보세요'.\n"
            "- Use one clear workplace request from a manager, client, customer, or team member instead of a broad report brief.\n"
            "- Keep the mission solvable without prior professional knowledge; put every needed clue inside the provided materials.\n"
            "- If the job normally uses specialist terms, explain or embed the needed meaning in the materials and task text.\n"
            "- If learner-facing text uses a specialist or potentially confusing term, add the term and a short plain-Korean definition to mission.scenario.glossary.\n"
            "- Ask the learner to notice, choose, compare, explain, or suggest; avoid expert-only analysis, formulas, legal judgment, investment advice, or domain trivia unless fully explained by the materials.\n"
            "- Keep learner-facing text concise: one main question, one concrete situation, and the exact number of guided task steps required by difficulty.\n\n"
            "Stability requirements:\n"
            "- Use mission_fact_refs as key names only, such as org_name, domain, period, trend_pattern, main_issue, feedback_themes, and decision_goal.\n"
            "- Do not use mission_facts.period, mission_fact_period, source_ref fields, XML fields, or invented fact labels as mission_fact_refs.\n"
            "- Make evaluation.rubric points sum exactly to 100.\n"
            "- Use exact job_profile evidence item names in evaluation.rubric.linked_evidence; do not use material ids such as mat_001, mat_002, or m1.\n"
            "- Respect material size limits: chart easy 3-4, normal 4-5, hard 4-5 x values; log easy 2-3, normal 3-4, hard 3-4 entries; checklist easy 2, normal 3, hard 3 items.\n"
            "- Respect material size limits: memo easy 1-2, normal 2-3, hard 2-3 items; email easy/normal/hard 1 thread item; table max easy 3 rows, normal 4 rows, hard 4 rows.\n"
            "- Respect material size limits: schedule easy 1-2, normal 2-3, hard 2-3 items; card easy 2 cards, normal 2-3 cards, hard 2-3 cards.\n"
            "- Keep chart series count at 1 or 2.\n\n"
            "Type-specific material data requirements:\n"
            "- chart data uses only chart_type, x_axis, y_axis, series.\n"
            "- table data uses only columns, rows.\n"
            "- memo data uses only author, items.\n"
            "- email data uses only thread.\n"
            "- schedule data uses only items, and each item has period, task, constraint. Do not include chart_type, x_axis, y_axis, series, columns, or rows in schedule data.\n"
            "- checklist data uses only items, and each item has label, status, importance.\n"
            "- log data uses only entries.\n"
            "- card data uses only cards.\n\n"
            "Every material.evidence_source item must exactly match a job_profile evidence item name.\n"
            "Do not use source_ref file names, XML field names, or invented evidence labels as evidence_source.\n"
            "For table materials, data.columns keys must be option, strength, weakness, priority and rows must use the same keys.\n\n"
            "The detailed JSON shape is enforced by the API structured output configuration; "
            "use the package rules for mission intent and constraints.\n\n"
            f"{practice_requirements}\n"
            f"llm_input_package:\n{json.dumps(prompt_input_package, ensure_ascii=False)}"
        )
        return {"system": system_prompt, "user": user_prompt}

    @staticmethod
    def _prompt_input_package(llm_input_package: dict[str, Any]) -> dict[str, Any]:
        """prompt에 넣을 입력에서 API로 따로 전달되는 큰 schema만 제거한다."""

        prompt_input_package = copy.deepcopy(llm_input_package)
        schema_constraints = prompt_input_package.get("schema_constraints")
        if isinstance(schema_constraints, dict):
            # 전체 JSON schema는 API structured output 설정으로 전달하므로 prompt 본문에서는 빼서 토큰을 줄인다.
            schema_constraints.pop("structured_output_schema", None)
        return prompt_input_package


class MockMissionDraftBuilder:
    """API 호출 없이 저장 구조와 validator 흐름을 확인하기 위한 고정 패턴 draft 생성기."""

    def build(self, llm_input_package: dict[str, Any]) -> dict[str, Any]:
        """mock run에서 실제 API 대신 사용할 mission_output.v1 초안을 만든다."""

        profile = llm_input_package["job_profile"]
        decisions = llm_input_package["system_decisions"]
        seed = llm_input_package.get("mission_seed")
        difficulty = decisions["difficulty"]["level"]
        job_cd = profile["job_identity"]["job_cd"]
        context = self._context(job_cd, profile, seed)
        material_min, material_max = decisions["difficulty"]["material_count_range"]
        material_count = material_max
        if seed and seed.get("material_blueprints"):
            material_count = min(max(len(seed.get("material_blueprints") or []), material_min), material_max)
        seed_material_types = [
            item.get("learner_visible_material_type")
            for item in (seed.get("material_blueprints") or [])
            if item.get("learner_visible_material_type") in decisions["allowed_material_types"]
        ] if seed else []
        material_types = seed_material_types[:material_count] or decisions["allowed_material_types"][:material_count]
        # 두 단계 생성의 mock: 설계서가 자료마다 정한 형태를 그대로 따른다(개수와 허용 형태가 맞을 때).
        plan = sorted((llm_input_package.get("mission_blueprint") or {}).get("materials") or [], key=lambda item: item.get("slot") or 0)
        planned_types = [item.get("type") for item in plan]
        if len(planned_types) == material_count and all(kind in decisions["allowed_material_types"] for kind in planned_types):
            material_types = planned_types
        if len(material_types) < material_count:
            for candidate in ("chart", "table", "memo", "email", "schedule", "checklist", "log", "card"):
                if candidate in decisions["allowed_material_types"] and candidate not in material_types:
                    material_types.append(candidate)
                if len(material_types) == material_count:
                    break

        facts = self._mission_facts(context, difficulty)
        materials = [
            self._material(idx, material_type, facts, context, profile, difficulty)
            for idx, material_type in enumerate(material_types, start=1)
        ]
        tasks = self._tasks(materials, context, difficulty, decisions["difficulty"].get("task_count_range"), seed)

        draft = self._base_draft(profile, decisions, facts, context, materials, tasks, difficulty)
        ncs = llm_input_package.get("job_ncs_background")
        if ncs and llm_input_package.get("schema_constraints", {}).get("ncs_basis_required"):
            # mock에서도 사용 근거 기록 흐름을 확인할 수 있게 첫 수행준거를 그대로 적는다.
            first = next(((e["name"], c) for e in ncs.get("elements", []) for c in e.get("performance_criteria", [])), ("", ""))
            draft["ncs_basis"] = {
                "unit_name": ncs["competency_unit"]["name"],
                "performance_criteria": [{"element_name": first[0], "text": first[1]}],
                "how_used": "mock: 첫 수행준거를 과제의 근거로 적었다.",
            }
        constraints = llm_input_package.get("schema_constraints", {})
        if constraints.get("basis_map_required"):
            # 두 단계 생성의 mock: 프로필이 설계서가 고른 KNOW 항목만 남게 줄어 있으므로 허용된 이름을 그대로 쓰고,
            # 채점 기준은 모두 설계서의 첫 채점 근거와 짝을 짓는다.
            names = list(constraints.get("material_rules", {}).get("allowed_evidence_names", []))[:2]
            for material in draft["mission"]["materials"]:
                material["evidence_source"] = list(names)
            for criterion in draft["evaluation"]["rubric"]:
                criterion["linked_evidence"] = list(names)
            for item in draft.get("evidence_chain_draft", {}).get("material_evidence_map", []):
                item["supported_by"] = list(names)
            draft["basis_map"] = {
                "rubric": [
                    {"rubric_index": index, "evaluation_basis_index": 0}
                    for index in range(len(draft["evaluation"]["rubric"]))
                ]
            }
            # 두 단계 작성 규칙(blueprint-writer-v8)처럼 분량은 한국어 "N~M문장" 하나로, 예상 시간은 난이도 값으로 맞춘다.
            # 두 단계가 아닌 경로의 mock 초안은 그대로다(프롬프트 지문 기준).
            level = decisions["difficulty"]
            hint = korean_length_hint(level.get("answer_length_hint"))
            submission = draft["mission"]["submission_format"]
            if hint:
                submission["length_hint"] = hint
                range_text = hint.split()[-1]
                for task in draft["mission"]["tasks"]:
                    task["instruction"] = re.sub(r"\d+\s*~\s*\d+\s*문장", range_text, task["instruction"])
            if level.get("estimated_time_minutes") is not None:
                submission["estimated_time_minutes"] = level["estimated_time_minutes"]
        return draft

    def _base_draft(self, profile, decisions, facts, context, materials, tasks, difficulty) -> dict[str, Any]:
        return {
            "schema_version": "mission_output.v1",
            "mission_id": "draft",
            "job_identity": copy.deepcopy(profile["job_identity"]),
            "target_exec_job": copy.deepcopy(decisions["selected_exec_job"]),
            "mission_facts": facts,
            "mission": {
                "title": f"{context['domain']} 자료 검토 미션",
                "task_type": decisions["primary_task_type"],
                "secondary_task_types": copy.deepcopy(decisions["secondary_task_types"]),
                "difficulty": copy.deepcopy(decisions["difficulty"]),
                "scenario": {
                    "role": context["role"],
                    "context": context["scenario_context"],
                    "goal": facts["decision_goal"],
                    "constraints": [
                        "제공된 자료만 사용한다.",
                        "최소 2개 이상의 자료를 근거로 연결한다.",
                        "외부 검색이나 전문 법률·투자·보험 지식 없이 판단한다.",
                    ],
                    "glossary": [],
                },
                "materials": materials,
                "tasks": tasks,
                "submission_format": self._submission_format(difficulty),
            },
            "evaluation": self._evaluation(profile, tasks),
            "evidence_chain_draft": {
                "source_exec_job": {
                    "id": decisions["selected_exec_job"]["exec_job_id"],
                    "text": decisions["selected_exec_job"]["text"],
                },
                "linked_evidence": {
                    "activities": [item["name"] for item in profile["evidence"]["work_activities"][:3]],
                    "knowledge": [item["name"] for item in profile["evidence"]["knowledge"][:2]],
                    "abilities": [item["name"] for item in profile["evidence"]["abilities"][:2]],
                },
                "material_evidence_map": [
                    {"material_id": material["material_id"], "supported_by": material["evidence_source"]}
                    for material in materials
                ],
            },
            "reliability": {"status": "pending_validation"},
        }

    def _context(self, job_cd: str, profile: dict[str, Any], seed: dict[str, Any] | None = None) -> dict[str, str]:
        """mock draft가 직무별로 그럴듯한 시나리오 기본값을 갖도록 맥락을 만든다."""

        defaults = {
            "K000000997": {
                "org_name": "B가게",
                "domain": "생활용품 상품",
                "role": "상품기획 담당자",
                "scenario_context": "온라인 생활용품 판매팀에서 다음 달 테스트 상품 방향을 검토하고 있다.",
            },
            "K000001080": {
                "org_name": "D서비스팀",
                "domain": "서비스 이용 데이터",
                "role": "데이터분석 담당자",
                "scenario_context": "온라인 서비스 운영팀에서 최근 이용 지표 변화와 고객 행동 로그를 검토하고 있다.",
            },
            "K000001179": {
                "org_name": "F투자팀",
                "domain": "투자 후보 검토",
                "role": "투자분석 담당자",
                "scenario_context": "투자 검토 회의 전 산업 지표와 후보 기업 요약 자료를 비교하고 있다.",
            },
            "K000007519": {
                "org_name": "H보험 기획팀",
                "domain": "보험상품 개선안",
                "role": "보험상품개발 담당자",
                "scenario_context": "보험상품 기획팀에서 고객 반응과 위험 점검 자료를 바탕으로 개선 방향을 정리하고 있다.",
            },
        }
        context = defaults.get(
            job_cd,
            {
                "org_name": "A팀",
                "domain": profile["job_identity"].get("job_smcl_nm", "업무"),
                "role": f"{profile['job_identity'].get('job_smcl_nm', '직무')} 담당자",
                "scenario_context": "팀 내부 검토 회의 전 제공 자료를 정리하고 있다.",
            },
        )
        if seed:
            basis = seed.get("scenario_basis") or {}
            context["role"] = basis.get("learner_role") or context["role"]
            context["scenario_context"] = basis.get("work_context") or context["scenario_context"]
            context["decision_goal"] = basis.get("goal") or f"{context['domain']}에 대해 다음 실행 방향 1가지를 근거와 함께 제안한다."
        return context

    def _mission_facts(self, context: dict[str, str], difficulty: str) -> dict[str, Any]:
        """mock 자료들이 공유해서 참조할 synthetic mission_facts를 만든다."""

        month_count = {"easy": 3, "normal": 4, "hard": 5}.get(difficulty, 4)
        months = ["1월", "2월", "3월", "4월", "5월"][:month_count]
        return {
            "org_name": context["org_name"],
            "domain": context["domain"],
            "period": months,
            "trend_pattern": "중반까지 개선되다가 최근 두 기간에서 하락 또는 정체가 나타남",
            "main_issue": "핵심 지표가 최근 약해지고 부정 의견이 늘어남",
            "feedback_themes": ["가격 대비 만족도 약화", "대안 비교 필요", "실행 전 제약 확인 필요"],
            "decision_goal": context.get("decision_goal") or f"{context['domain']}에 대해 다음 실행 방향 1가지를 근거와 함께 제안한다.",
        }

    def _material(
        self,
        idx: int,
        material_type: str,
        facts: dict[str, Any],
        context: dict[str, str],
        profile: dict[str, Any],
        difficulty: str,
    ) -> dict[str, Any]:
        """mock run에서 validator를 통과할 수 있는 자료 객체 하나를 만든다."""

        material_id = f"mat_{idx:03d}"
        evidence_source = self._evidence_sources(profile, material_type)
        base = {
            "material_id": material_id,
            "type": material_type,
            "subtype": self._subtype(material_type),
            "title": self._title(material_type, context),
            "description": f"{facts['domain']} 판단에 필요한 {material_type} 자료다.",
            "factual_status": "synthetic_mission_material",
            "used_for": "핵심 문제와 실행 방향 판단",
            "evidence_source": evidence_source,
            "mission_fact_refs": ["period", "trend_pattern", "main_issue", "decision_goal"],
            "data": self._material_data(material_type, facts, difficulty),
            "confidence": {"score": 0.86, "checks": {"synthetic_material": True}, "warnings": []},
        }
        if material_type in {"memo", "email", "checklist", "log"}:
            base["mission_fact_refs"] = ["main_issue", "feedback_themes", "decision_goal"]
        if material_type in {"schedule", "card"}:
            base["mission_fact_refs"] = ["decision_goal", "feedback_themes"]
        return base

    def _subtype(self, material_type: str) -> str:
        return {
            "chart": "monthly_trend",
            "table": "comparison_table",
            "memo": "feedback_summary",
            "email": "manager_request",
            "schedule": "work_schedule",
            "checklist": "risk_checklist",
            "log": "activity_log",
            "card": "option_card",
        }[material_type]

    def _title(self, material_type: str, context: dict[str, str]) -> str:
        labels = {
            "chart": "월별 핵심 지표 추이",
            "table": "대안 비교표",
            "memo": "고객 반응 요약 메모",
            "email": "팀장 요청 이메일",
            "schedule": "실행 일정표",
            "checklist": "실행 전 점검표",
            "log": "최근 처리 로그",
            "card": "대안 카드",
        }
        return f"{context['org_name']} {labels[material_type]}"

    def _material_data(self, material_type: str, facts: dict[str, Any], difficulty: str) -> dict[str, Any]:
        """자료 유형과 난이도에 맞는 mock data payload를 만든다."""

        periods = facts["period"]
        hard = difficulty == "hard"
        easy = difficulty == "easy"
        # mock 자료는 API 없이도 validator와 UI export 흐름을 확인할 수 있는 최소 샘플이다.
        if material_type == "chart":
            values = [72, 76, 81, 84, 73, 69, 68][: len(periods)]
            return {
                "chart_type": "line",
                "x_axis": {"label": "기간", "values": periods},
                "y_axis": {"label": "핵심 지표", "unit": "점"},
                "series": [{"name": "핵심 지표", "values": values}],
            }
        if material_type == "table":
            rows = [
                {"option": "A안", "strength": "기존 고객 반응 안정", "weakness": "차별성 약함", "priority": 2},
                {"option": "B안", "strength": "최근 이슈 직접 개선", "weakness": "일정 확인 필요", "priority": 1},
                {"option": "C안", "strength": "비용 부담 낮음", "weakness": "효과 검증 부족", "priority": 3},
            ]
            if hard:
                rows.append({"option": "D안", "strength": "장기 확장 가능", "weakness": "초기 조율 필요", "priority": 4})
            if easy:
                rows = rows[:2]
            return {
                "columns": [
                    {"key": "option", "label": "대안"},
                    {"key": "strength", "label": "강점"},
                    {"key": "weakness", "label": "약점"},
                    {"key": "priority", "label": "우선순위"},
                ],
                "rows": rows,
            }
        if material_type == "memo":
            items = [
                "최근 두 기간에서 만족도 관련 부정 의견이 늘었다.",
                "가격 대비 효용을 더 명확히 보여달라는 의견이 반복되었다.",
                "기존 방식은 안정적이지만 새로움이 부족하다는 평가가 있었다.",
                "빠른 개선보다 핵심 불만을 먼저 줄이는 방향이 필요하다.",
            ]
            if hard:
                items.append("일정과 비용 제약 때문에 한 번에 모든 대안을 실행하기 어렵다.")
            if easy:
                items = items[:2]
            else:
                items = items[:3]
            return {"author": "고객지원 담당자", "items": items}
        if material_type == "email":
            body = "최근 지표와 고객 반응을 함께 보고 다음 회의 전 실행 방향을 정리해주세요. 제공 자료 안에서 근거를 연결하고, 실행 전 확인할 제약도 함께 적어주세요."
            return {"thread": [{"from": "팀장", "to": "담당자", "subject": "다음 실행 방향 검토 요청", "body": body}]}
        if material_type == "schedule":
            items = [
                {"period": "1주차", "task": "자료 재확인", "constraint": "기존 자료 범위 안에서 검토"},
                {"period": "2주차", "task": "대안 1차 선정", "constraint": "2개 이하로 압축"},
                {"period": "3주차", "task": "관련 부서 확인", "constraint": "일정 변경 1회만 가능"},
                {"period": "4주차", "task": "실행안 확정", "constraint": "핵심 지표 개선 목표 포함"},
            ]
            if hard:
                items.append({"period": "5주차", "task": "결과 점검 계획 수립", "constraint": "평가 기준 사전 합의"})
            if easy:
                items = items[:2]
            else:
                items = items[:3]
            return {"items": items}
        if material_type == "checklist":
            return {
                "items": [
                    {"label": "핵심 지표 하락 원인이 자료에서 확인되는가", "status": "unchecked", "importance": "high"},
                    {"label": "선택 대안이 고객 반응 이슈를 줄이는가", "status": "issue", "importance": "high"},
                    {"label": "실행 일정 안에 검토가 가능한가", "status": "unchecked", "importance": "medium"},
                    {"label": "선택하지 않은 대안의 이유가 설명되는가", "status": "unchecked", "importance": "medium"},
                    {"label": "추가 외부 조사가 없어도 판단 가능한가", "status": "checked", "importance": "high"},
                ][: 2 if easy else 3]
            }
        if material_type == "log":
            entries = [
                {"time": "1주차", "actor": "고객", "event": "이용 불편 의견 접수", "note": "핵심 기능 설명 부족"},
                {"time": "2주차", "actor": "운영 담당자", "event": "반복 문의 확인", "note": "같은 유형 문의 증가"},
                {"time": "3주차", "actor": "고객", "event": "대안 비교 요청", "note": "가격과 효과 비교 필요"},
                {"time": "4주차", "actor": "팀장", "event": "개선 방향 검토 요청", "note": "자료 기반 판단 필요"},
            ]
            if hard:
                entries.extend(
                    [
                        {"time": "5주차", "actor": "담당자", "event": "우선순위 재검토", "note": "일정 제약 발생"},
                        {"time": "6주차", "actor": "고객", "event": "만족도 하락 의견", "note": "핵심 이슈 재확인"},
                    ]
                )
            if easy:
                entries = entries[:3]
            else:
                entries = entries[:4]
            return {"entries": entries}
        return {
            "cards": [
                {"title": "A안", "attributes": {"강점": "안정적", "약점": "차별성 낮음", "적합도": "보통"}},
                {"title": "B안", "attributes": {"강점": "이슈 직접 대응", "약점": "일정 확인", "적합도": "높음"}},
                {"title": "C안", "attributes": {"강점": "비용 낮음", "약점": "효과 불명확", "적합도": "낮음"}},
            ][: 2 if easy else 3]
        }

    def _tasks(
        self,
        materials: list[dict[str, Any]],
        context: dict[str, str],
        difficulty: str,
        task_count_range: list[int] | tuple[int, int] | None,
        seed: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """난이도별 task 개수와 mission_seed task plan을 반영해 mock task를 만든다."""

        material_ids = [material["material_id"] for material in materials]
        if task_count_range and len(task_count_range) >= 2:
            task_max = int(task_count_range[1])
        else:
            task_max = {"easy": 1, "normal": 1, "hard": 1}.get(difficulty, 1)
        if seed and seed.get("task_plan"):
            tasks = []
            for index, plan in enumerate(seed["task_plan"][:task_max], start=1):
                instruction = plan.get("instruction") if isinstance(plan, dict) else str(plan)
                required = material_ids[:1] if index == 1 else material_ids
                tasks.append(
                    {
                        "task_id": f"task_{index:03d}",
                        "instruction": instruction,
                        "required_materials": required,
                        "expected_action": plan.get("expected_action", "practice_survey_guided_action") if isinstance(plan, dict) else "practice_survey_guided_action",
                    }
                )
            return tasks
        tasks = [
            {
                "task_id": "task_001",
                "instruction": "자료에서 최근 흐름상 가장 큰 문제 1가지와 그 근거를 2~3문장으로 작성하세요.",
                "required_materials": material_ids[:2],
                "expected_action": "analyze_issue",
            },
            {
                "task_id": "task_002",
                "instruction": "문제 원인을 줄이기 위한 실행 방향 1가지를 선택하고, 선택 이유를 2~3문장으로 작성하세요.",
                "required_materials": material_ids,
                "expected_action": "choose_action",
            },
            {
                "task_id": "task_003",
                "instruction": "선택한 방향을 실행하기 전에 확인해야 할 주의점 1가지를 2~3문장으로 작성하세요.",
                "required_materials": material_ids[-2:] if len(material_ids) >= 2 else material_ids,
                "expected_action": "identify_risk",
            },
        ]
        return tasks[:task_max]

    def _submission_format(self, difficulty: str) -> dict[str, Any]:
        """mock mission의 난이도별 제출 형식과 길이 힌트를 만든다."""

        if difficulty == "easy":
            return {
                "type": "single_response",
                "estimated_time_minutes": 10,
                "required_sections": ["발견한 점 1가지", "제안 1가지"],
                "length_hint": "1-2 short sentences",
            }
        if difficulty == "normal":
            return {
                "type": "guided_short_report",
                "estimated_time_minutes": 15,
                "required_sections": ["핵심 발견 1가지", "근거 자료 2개", "제안 1가지"],
                "length_hint": "2-3 short sentences",
            }
        return {
            "type": "decision_memo",
            "estimated_time_minutes": 20,
            "required_sections": ["문제와 근거", "선택한 방향과 이유"],
            "length_hint": "3-5 short sentences",
        }

    def _evaluation(self, profile: dict[str, Any], tasks: list[dict[str, Any]]) -> dict[str, Any]:
        """mock mission의 평가 기준과 profile evidence 연결을 만든다."""

        linked = [item["name"] for item in profile["evidence"]["work_activities"][:3]]
        return {
            "expected_insights": [
                "수치 흐름과 정성 의견을 함께 연결해야 한다.",
                "제안은 제공 자료에서 확인되는 문제와 직접 연결되어야 한다.",
                "실행 전 제약이나 리스크를 함께 고려해야 한다.",
            ],
            "rubric": [
                {
                    "criterion": "자료 해석",
                    "description": "제공 자료에서 핵심 흐름과 문제를 정확히 찾았는가",
                    "points": 30,
                    "linked_evidence": linked[:2],
                },
                {
                    "criterion": "근거 기반 판단",
                    "description": "선택한 방향이 2개 이상의 자료 근거와 연결되는가",
                    "points": 40,
                    "linked_evidence": linked,
                },
                {
                    "criterion": "실행 가능성",
                    "description": "제안과 주의점이 시간 안에 수행 가능한 형식으로 정리되었는가",
                    "points": 30,
                    "linked_evidence": linked[-2:],
                },
            ],
        }

    def _evidence_sources(self, profile: dict[str, Any], material_type: str) -> list[str]:
        """자료 유형별로 가장 연결이 자연스러운 profile evidence 이름을 고른다."""

        preferences = {
            "chart": ["정보, 자료 분석", "정보 수집", "사물, 행동, 사건 파악"],
            "table": ["기준에 따른 정보 평가", "의사 결정, 문제점 해결", "목표, 전략 수립", "정보 처리"],
            "memo": ["정보 수집", "사물, 행동, 사건 파악", "상사, 동료, 부하직원과 소통"],
            "email": ["상사, 동료, 부하직원과 소통", "조직 외부인과 소통", "이메일 이용하기"],
            "schedule": ["업무, 활동에 대한 일정관리", "업무 계획, 우선순위 결정", "마감시간"],
            "checklist": ["기준에 따른 정보 평가", "의사 결정, 문제점 해결", "업무 계획, 우선순위 결정"],
            "log": ["정보 처리", "컴퓨터 업무", "정보 수집"],
            "card": ["창조적 생각", "목표, 전략 수립", "의사 결정, 문제점 해결"],
        }
        all_items = [item for group in profile.get("evidence", {}).values() for item in group]
        names = {item["name"] for item in all_items}
        selected = [name for name in preferences[material_type] if name in names]
        if len(selected) >= 2:
            return selected[:2]
        for item in profile.get("evidence", {}).get("work_activities", []):
            if item["name"] not in selected:
                selected.append(item["name"])
            if len(selected) >= 2:
                break
        if not selected and all_items:
            selected.append(all_items[0]["name"])
        return selected[:2]
