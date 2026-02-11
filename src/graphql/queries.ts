export const VIEWER_QUERY = `query Viewer { viewer { id } }`;

export const ISSUE_INFO_QUERY = `
  query IssueInfo($id: String!) {
    issue(id: $id) {
      id
      state { type }
      team { id }
      delegate { id }
    }
  }
`;

export const ISSUE_DETAIL_QUERY = `
  query IssueDetail($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      url
      priority
      priorityLabel
      state { id name type }
      team { id key name }
      assignee { id name displayName }
      delegate { id name displayName }
      labels { nodes { id name color } }
      parent { id identifier title }
      children { nodes { id identifier title state { type } } }
      relations { nodes { id type relatedIssue { id identifier title } } }
      comments(first: 20) {
        nodes { id body createdAt user { id name displayName } }
      }
    }
  }
`;

export const TEAM_STARTED_QUERY = `
  query TeamStartedStates($id: String!) {
    team(id: $id) {
      states(filter: { type: { eq: "started" } }) {
        nodes { id position }
      }
    }
  }
`;

export const TEAM_COMPLETED_QUERY = `
  query TeamCompletedStates($id: String!) {
    team(id: $id) {
      states(filter: { type: { eq: "completed" } }) {
        nodes { id position }
      }
    }
  }
`;

export const TEAM_DETAIL_QUERY = `
  query TeamDetail($id: String!) {
    team(id: $id) {
      id
      key
      name
      states { nodes { id name type position } }
      labels { nodes { id name color } }
      members { nodes { id name displayName } }
    }
  }
`;

export const COMMENT_SESSION_QUERY = `
  query CommentSession($id: String!) {
    comment(id: $id) {
      id
      parentId
      agentSession { id }
      agentSessions(first: 3) {
        nodes { id }
      }
      parent {
        id
        parentId
        agentSession { id }
        agentSessions(first: 3) {
          nodes { id }
        }
      }
    }
  }
`;

export const ISSUE_SESSION_QUERY = `
  query IssueSession($id: String!) {
    issue(id: $id) {
      comments(first: 25) {
        nodes {
          id
          parentId
          agentSession { id }
          agentSessions(first: 3) {
            nodes { id }
          }
        }
      }
    }
  }
`;

export const REPO_SUGGESTIONS_QUERY = `
  query RepoSuggestions(
    $issueId: String!,
    $agentSessionId: String!,
    $candidateRepositories: [CandidateRepositoryInput!]!
  ) {
    issueRepositorySuggestions(
      issueId: $issueId
      agentSessionId: $agentSessionId
      candidateRepositories: $candidateRepositories
    ) {
      suggestions {
        repositoryFullName
        hostname
        confidence
      }
    }
  }
`;
