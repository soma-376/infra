# 로컬 에이전트 skill

공통 skill 원본은 형제 `agent-skills` 저장소에 있다. 개발 환경에서 필요한
`.agents/skills` 링크는 로컬에만 만들고 Git에는 추가하지 않는다.
Argo CD는 이 저장소를 그대로 렌더하므로 저장소 바깥을 가리키는 추적 symlink를 허용하지 않는다.
