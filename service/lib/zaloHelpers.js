function collectIdentifiers(...values) {
  const identifiers = new Set();
  values.forEach((value) => {
    const text = String(value || '').trim();
    if (text) identifiers.add(text);
  });
  return identifiers;
}

export function isGroupJob(job) {
  if (job?.isGroup === true) return true;
  if (job?.isGroup === false) return false;
  const tab = String(job?.sourceTab || '').toLowerCase();
  return tab.includes('nhóm') || tab.includes('nhom') || tab === 'group' || tab === 'groups';
}

export function normalizeThreadId(value, isGroup) {
  const text = String(value || '').trim();
  if (!text || text === '—') return text;
  if (isGroup && (text.startsWith('g') || text.startsWith('G'))) {
    return text.slice(1);
  }
  return text;
}

export function getDelayMs(delayWindow) {
  const match = String(delayWindow || '').match(/(\d+)\s*-\s*(\d+)/);
  if (!match) return 0;

  const first = Number(match[1]);
  const second = Number(match[2]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return 0;

  const min = Math.min(first, second);
  const max = Math.max(first, second);
  return (min + Math.floor(Math.random() * (max - min + 1))) * 1000;
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

function normalizeMemberVersionKey(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.split('_').length > 1) return text;
  return `${text}_0`;
}

function buildFriendIdentifierSet(friends) {
  const identifiers = new Set();
  (Array.isArray(friends) ? friends : []).forEach((friend) => {
    collectIdentifiers(friend?.userId, friend?.username, friend?.globalId).forEach((value) => identifiers.add(value));
  });
  return identifiers;
}

export function extractGroupMemberIds(group) {
  const ids = new Set();

  const pushId = (value) => {
    const text = String(value || '').trim();
    if (text) ids.add(text);
  };

  if (Array.isArray(group?.memberIds)) {
    group.memberIds.forEach((item) => pushId(item));
  }

  if (Array.isArray(group?.currentMems)) {
    group.currentMems.forEach((item) => {
      if (typeof item === 'object' && item !== null) {
        pushId(item.id || item.userId || item.uid);
      } else {
        pushId(item);
      }
    });
  }

  if (Array.isArray(group?.updateMems)) {
    group.updateMems.forEach((item) => {
      if (typeof item === 'object' && item !== null) {
        pushId(item.id || item.userId || item.uid);
      } else {
        pushId(item);
      }
    });
  }

  if (Array.isArray(group?.memVerList)) {
    group.memVerList.forEach((item) => pushId(item));
  }

  return Array.from(ids);
}

export function summarizeGroupMap(groupInfo, hiddenGroupIds = new Set()) {
  const map = groupInfo?.gridInfoMap || {};
  return Object.values(map).map((group) => ({
    userId: group.groupId || '',
    displayName: group.name || '',
    avatar: group.avt || group.fullAvt || '',
    totalMember: group.totalMember || 0,
    memberIds: extractGroupMemberIds(group),
    creatorId: group.creatorId || '',
    desc: group.desc || '',
    globalId: group.globalId || '',
    type: group.type,
    subType: group.subType,
    isHiddenConversation: hiddenGroupIds.has(String(group.groupId || '').trim()),
  }));
}

export function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export async function safeApiCall(callback, fallbackValue) {
  try {
    return await callback();
  } catch (_) {
    return fallbackValue;
  }
}

export function normalizeSentFriendRequests(requestsMap) {
  return Object.values(requestsMap || {}).map((item) => ({
    userId: item.userId || '',
    displayName: item.displayName || item.zaloName || 'Không rõ tên',
    zaloName: item.zaloName || '',
    avatar: item.avatar || '',
    globalId: item.globalId || '',
    message: item.fReqInfo?.message || '',
    requestedAt: item.fReqInfo?.time || 0,
    source: item.fReqInfo?.src || 0,
  }));
}

export function normalizeReceivedFriendRequests(response) {
  return Array.isArray(response?.recommItems)
    ? response.recommItems.map((item) => ({
        userId: item.dataInfo?.userId || '',
        displayName: item.dataInfo?.displayName || item.dataInfo?.zaloName || 'Không rõ tên',
        zaloName: item.dataInfo?.zaloName || '',
        avatar: item.dataInfo?.avatar || '',
        phoneNumber: item.dataInfo?.phoneNumber || '',
        status: item.dataInfo?.status || '',
        recommTime: item.dataInfo?.recommTime || 0,
        recommType: item.dataInfo?.recommType,
        isSeenFriendReq: Boolean(item.dataInfo?.isSeenFriendReq),
        message: item.dataInfo?.recommInfo?.message || '',
      }))
    : [];
}

export async function resolveInviteTargetsFromGroups(api, groups, accountUserId) {
  const groupIds = groups
    .map((group) => normalizeThreadId(group?.groupId || group?.zid, true))
    .filter(Boolean);

  if (!groupIds.length) {
    return [];
  }

  const [friendsResponse, groupInfo] = await Promise.all([
    safeApiCall(() => api.getAllFriends(), []),
    api.getGroupInfo(groupIds),
  ]);

  const existingFriendIds = buildFriendIdentifierSet(friendsResponse);
  const selfId = String(accountUserId || '').trim();
  const targets = [];
  const groupSummaries = [];

  for (const groupId of groupIds) {
    const group = groupInfo?.gridInfoMap?.[groupId];
    const memberVersionKeys = extractGroupMemberIds(group).map((memberId) => normalizeMemberVersionKey(memberId));
    const relevantMemberKeys = memberVersionKeys.filter(Boolean);

    if (!relevantMemberKeys.length) {
      groupSummaries.push({
        groupId,
        groupName: group?.name || 'Nhóm',
        totalMembers: 0,
        friendCount: 0,
        incomingRequestCount: 0,
        outgoingRequestCount: 0,
        inviteableCount: 0,
      });
      continue;
    }

    const profileChunks = chunk(relevantMemberKeys, 200);
    const groupProfileMap = {};
    const userInfoMap = {};

    for (const ids of profileChunks) {
      if (!ids.length) continue;
      const groupMembersResponse = await safeApiCall(
        () => withTimeout(api.getGroupMembersInfo(ids), 15000, 'Lấy thành viên nhóm quá chậm.'),
        { profiles: {} },
      );
      Object.assign(groupProfileMap, groupMembersResponse?.profiles || {});

      const userInfoResponse = await safeApiCall(
        () => withTimeout(api.getUserInfo(ids), 15000, 'Lấy hồ sơ thành viên quá chậm.'),
        { changed_profiles: {} },
      );
      Object.assign(userInfoMap, userInfoResponse?.changed_profiles || {});
    }

    const relationStatuses = new Map();
    for (const memberKey of relevantMemberKeys) {
      const profile = userInfoMap[memberKey] || groupProfileMap[memberKey] || {};
      const actualUserId = String(profile?.userId || profile?.id || '').trim();

      if (!actualUserId || actualUserId === selfId) {
        continue;
      }

      const profileIdentifiers = collectIdentifiers(
        memberKey,
        actualUserId,
        profile?.id,
        profile?.userId,
        profile?.globalId,
        profile?.username,
      );

      const alreadyFriend = Number(profile?.isFr) === 1
        || Array.from(profileIdentifiers).some((identifier) => existingFriendIds.has(identifier));
      if (alreadyFriend) {
        relationStatuses.set(memberKey, {
          is_friend: 1,
          is_requested: 0,
          is_requesting: 0,
        });
        continue;
      }

      const status = await safeApiCall(
        () => withTimeout(api.getFriendRequestStatus(actualUserId), 8000, 'Kiểm tra trạng thái bạn bè quá chậm.'),
        {
          is_friend: 0,
          is_requested: 0,
          is_requesting: 0,
        },
      );
      relationStatuses.set(memberKey, status || {
        is_friend: 0,
        is_requested: 0,
        is_requesting: 0,
      });
    }

    const candidateKeys = relevantMemberKeys.filter((memberKey) => {
      const profile = userInfoMap[memberKey] || groupProfileMap[memberKey] || {};
      const actualUserId = String(profile?.userId || profile?.id || '').trim();
      if (!actualUserId || actualUserId === selfId) return false;

      const relation = relationStatuses.get(memberKey) || {};
      return Number(relation.is_friend) !== 1
        && Number(relation.is_requested) !== 1
        && Number(relation.is_requesting) !== 1;
    });

    let friendCount = 0;
    let incomingRequestCount = 0;
    let outgoingRequestCount = 0;
    relationStatuses.forEach((relation) => {
      if (Number(relation?.is_friend) === 1) {
        friendCount += 1;
      } else if (Number(relation?.is_requested) === 1) {
        incomingRequestCount += 1;
      } else if (Number(relation?.is_requesting) === 1) {
        outgoingRequestCount += 1;
      }
    });

    groupSummaries.push({
      groupId,
      groupName: group?.name || 'Nhóm',
      totalMembers: relationStatuses.size,
      friendCount,
      incomingRequestCount,
      outgoingRequestCount,
      inviteableCount: candidateKeys.length,
    });

    if (!candidateKeys.length) {
      continue;
    }

    candidateKeys.forEach((memberKey) => {
      const profile = userInfoMap[memberKey] || groupProfileMap[memberKey] || {};
      const actualUserId = String(profile?.userId || profile?.id || '').trim();
      if (!actualUserId) return;

      targets.push({
        key: `${groupId}_${actualUserId}`,
        zid: actualUserId,
        name: profile.displayName || profile.zaloName || `Thành viên ${group?.name || 'nhóm'}`,
        avatar: profile.avatar || '',
        phone: '—',
        sourceTab: group?.name || 'Nhóm',
        groupId,
      });
    });
  }

  return {
    targets,
    summaries: groupSummaries,
    totals: groupSummaries.reduce((accumulator, summary) => ({
      totalMembers: accumulator.totalMembers + Number(summary.totalMembers || 0),
      friendCount: accumulator.friendCount + Number(summary.friendCount || 0),
      incomingRequestCount: accumulator.incomingRequestCount + Number(summary.incomingRequestCount || 0),
      outgoingRequestCount: accumulator.outgoingRequestCount + Number(summary.outgoingRequestCount || 0),
      inviteableCount: accumulator.inviteableCount + Number(summary.inviteableCount || 0),
    }), {
      totalMembers: 0,
      friendCount: 0,
      incomingRequestCount: 0,
      outgoingRequestCount: 0,
      inviteableCount: 0,
    }),
  };
}