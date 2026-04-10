import { MuteAction, MuteDuration, ThreadType } from 'zalo-api-final';
import { createApiClient, getUserAgent } from './apiClient.js';
import { writeJson } from './http.js';
import {
  chunk,
  getDelayMs,
  isGroupJob,
  normalizeReceivedFriendRequests,
  normalizeSentFriendRequests,
  normalizeThreadId,
  resolveInviteTargetsFromGroups,
  safeApiCall,
  sleep,
  summarizeGroupMap,
  withTimeout,
} from './zaloHelpers.js';

function writeServiceLoginError(res, error) {
  writeJson(res, 500, {
    ok: false,
    error: error instanceof Error ? error.message : 'Không thể khởi tạo phiên local service.',
    code: 'SERVICE_LOGIN_FAILED',
  });
}

function ensureCustomApiActions(api) {
  if (typeof api?.custom !== 'function') return;

  if (typeof api.rejectFriendRequest !== 'function') {
    api.custom('rejectFriendRequest', async ({ ctx, utils, props }) => {
      const userId = String(props?.userId || props || '').trim();
      const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/reject`);
      const encryptedParams = utils.encodeAES(JSON.stringify({
        fid: userId,
        language: ctx.language,
      }));

      if (!encryptedParams) {
        throw new Error('Failed to encrypt params');
      }

      const response = await utils.request(serviceURL, {
        method: 'POST',
        body: new URLSearchParams({
          params: encryptedParams,
        }),
      });

      return utils.resolve(response);
    });
  }
}

export async function handleAccountSync(req, res, body) {
  const account = body?.account;
  if (!account) {
    writeJson(res, 400, { ok: false, error: 'Thiếu account để đồng bộ.' });
    return;
  }

  const userAgent = getUserAgent(body, req);
  let api;
  try {
    ({ api } = await createApiClient(account, userAgent));
  } catch (error) {
    writeServiceLoginError(res, error);
    return;
  }
  ensureCustomApiActions(api);
  const [profile, friendsResponse, groupsResponse] = await Promise.all([
    api.fetchAccountInfo(),
    api.getAllFriends(),
    api.getAllGroups(),
  ]);
  const [sentFriendRequests, receivedFriendRequests] = await Promise.all([
    safeApiCall(() => api.getSentFriendRequest(), {}),
    safeApiCall(() => api.getReceivedFriendRequests(), { recommItems: [] }),
  ]);

  const groupIds = Object.keys(groupsResponse?.gridVerMap || {}).map((groupId) => normalizeThreadId(groupId, true));
  const hiddenConversationResponse = await safeApiCall(() => api.getHiddenConversations(), { threads: [] });
  const hiddenGroupIdSet = new Set(
    (Array.isArray(hiddenConversationResponse?.threads) ? hiddenConversationResponse.threads : [])
      .filter((thread) => Number(thread?.is_group) === 1)
      .map((thread) => normalizeThreadId(thread?.thread_id, true))
      .filter(Boolean),
  );
  const groupChunks = chunk(groupIds, 200);
  const groups = [];

  for (const ids of groupChunks) {
    if (!ids.length) continue;
    const info = await api.getGroupInfo(ids);
    groups.push(...summarizeGroupMap(info, hiddenGroupIdSet));
  }

  const knownGroupIds = new Set(groups.map((group) => String(group?.userId || '').trim()).filter(Boolean));
  const missingHiddenGroupIds = Array.from(hiddenGroupIdSet).filter((groupId) => !knownGroupIds.has(groupId));

  for (const ids of chunk(missingHiddenGroupIds, 200)) {
    if (!ids.length) continue;
    const info = await safeApiCall(() => api.getGroupInfo(ids), { gridInfoMap: {} });
    groups.push(...summarizeGroupMap(info, hiddenGroupIdSet));
  }

  writeJson(res, 200, {
    ok: true,
    data: {
      profile,
      friends: Array.isArray(friendsResponse) ? friendsResponse : [],
      groups,
      sentFriendRequests: normalizeSentFriendRequests(sentFriendRequests),
      receivedFriendRequests: normalizeReceivedFriendRequests(receivedFriendRequests),
      groupIds,
      userAgent,
      syncedAt: new Date().toISOString(),
    },
  });
}

export async function handleFriendRequestBatch(req, res, body) {
  const account = body?.account;
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];

  if (!account) {
    writeJson(res, 400, { ok: false, error: 'Thiếu account để gửi lời mời kết bạn.' });
    return;
  }

  if (!jobs.length) {
    writeJson(res, 400, { ok: false, error: 'Danh sách job kết bạn rỗng.' });
    return;
  }

  const userAgent = getUserAgent(body, req);
  let api;
  try {
    ({ api } = await createApiClient(account, userAgent));
  } catch (error) {
    writeServiceLoginError(res, error);
    return;
  }
  ensureCustomApiActions(api);

  const results = [];

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const userId = String(job?.zid || '').trim();
    const note = String(job?.note || '').trim();
    const startedAt = new Date().toISOString();

    if (!userId || userId === '—') {
      results.push({
        jobId: job?.id,
        ok: false,
        status: 'failed',
        statusLabel: 'Thiếu Zalo ID',
        error: 'Job không có Zalo ID hợp lệ để gửi lời mời.',
        startedAt,
        failedAt: new Date().toISOString(),
        provider: 'local-service',
      });
      continue;
    }

    try {
      const apiResult = await withTimeout(
        api.sendFriendRequest(note, userId),
        15000,
        `Gửi lời mời tới ${userId} quá chậm.`,
      );
      results.push({
        jobId: job.id,
        ok: true,
        status: 'sent',
        statusLabel: 'Đã gửi lời mời',
        startedAt,
        sentAt: new Date().toISOString(),
        provider: 'local-service',
        apiResult,
      });
    } catch (error) {
      const code = typeof error?.code === 'number' ? error.code : null;

      if (code === 222) {
        results.push({
          jobId: job.id,
          ok: true,
          status: 'accepted',
          statusLabel: 'Đã chấp nhận lời mời',
          startedAt,
          sentAt: new Date().toISOString(),
          provider: 'local-service',
          apiResult: null,
        });
      } else if (code === 225) {
        results.push({
          jobId: job.id,
          ok: true,
          status: 'skipped',
          statusLabel: 'Đã là bạn bè',
          startedAt,
          sentAt: new Date().toISOString(),
          provider: 'local-service',
          apiResult: null,
        });
      } else {
        results.push({
          jobId: job?.id,
          ok: false,
          status: 'failed',
          statusLabel: 'Kết bạn thất bại',
          error: error instanceof Error ? error.message : 'Gửi lời mời kết bạn thất bại.',
          startedAt,
          failedAt: new Date().toISOString(),
          provider: 'local-service',
        });
      }
    }

    if (index < jobs.length - 1) {
      const delayMs = getDelayMs(job?.delayWindow);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  writeJson(res, 200, {
    ok: true,
    provider: 'local-service',
    accepted: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  });
}

export async function handleGroupInviteTargets(req, res, body) {
  const account = body?.account;
  const groups = Array.isArray(body?.groups) ? body.groups : [];

  if (!account) {
    writeJson(res, 400, { ok: false, error: 'Thiếu account để lấy thành viên nhóm.' });
    return;
  }

  if (!groups.length) {
    writeJson(res, 400, { ok: false, error: 'Danh sách nhóm rỗng.' });
    return;
  }

  const userAgent = getUserAgent(body, req);
  let api;
  try {
    ({ api } = await createApiClient(account, userAgent));
  } catch (error) {
    writeServiceLoginError(res, error);
    return;
  }

  const resolution = await resolveInviteTargetsFromGroups(api, groups, account?.userId);

  writeJson(res, 200, {
    ok: true,
    targets: resolution.targets,
    total: resolution.targets.length,
    summaries: resolution.summaries,
    totals: resolution.totals,
    provider: 'local-service',
  });
}

export async function handleActionBatch(req, res, body) {
  const account = body?.account;
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];

  if (!account) {
    writeJson(res, 400, { ok: false, error: 'Thiếu account để thực thi thao tác.' });
    return;
  }

  if (!jobs.length) {
    writeJson(res, 400, { ok: false, error: 'Danh sách thao tác rỗng.' });
    return;
  }

  const userAgent = getUserAgent(body, req);
  let api;
  try {
    ({ api } = await createApiClient(account, userAgent));
  } catch (error) {
    writeServiceLoginError(res, error);
    return;
  }
  ensureCustomApiActions(api);

  const results = [];

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const actionType = String(job?.actionType || '').trim();
    const groupJob = isGroupJob(job);
    const zid = normalizeThreadId(job?.zid, groupJob);
    const startedAt = new Date().toISOString();

    if (!zid || zid === '—') {
      results.push({
        jobId: job?.id,
        ok: false,
        status: 'failed',
        statusLabel: 'Thiếu Zalo ID',
        error: 'Không tìm thấy Zalo ID hợp lệ để thực thi thao tác.',
        startedAt,
        failedAt: new Date().toISOString(),
        provider: 'local-service',
      });
      continue;
    }

    try {
      if (actionType === 'remove_friend') {
        if (groupJob) {
          throw new Error('Xóa bạn bè không áp dụng cho nhóm.');
        }

        const apiResult = await api.removeFriend(zid);
        results.push({
          jobId: job.id,
          ok: true,
          status: 'completed',
          statusLabel: 'Đã xóa bạn',
          startedAt,
          sentAt: new Date().toISOString(),
          provider: 'local-service',
          apiResult,
        });
      } else if (actionType === 'leave_group') {
        if (!groupJob) {
          throw new Error('Rời nhóm chỉ áp dụng cho hội thoại nhóm.');
        }

        const apiResult = await api.leaveGroup(zid);
        const memberErrors = Array.isArray(apiResult?.memberError) ? apiResult.memberError : [];
        if (memberErrors.includes(zid)) {
          throw new Error('Zalo từ chối thao tác rời nhóm cho nhóm đã chọn.');
        }

        results.push({
          jobId: job.id,
          ok: true,
          status: 'completed',
          statusLabel: 'Đã rời nhóm',
          startedAt,
          sentAt: new Date().toISOString(),
          provider: 'local-service',
          apiResult,
        });
      } else if (actionType === 'undo_friend_request') {
        if (groupJob) {
          throw new Error('Thu hồi lời mời không áp dụng cho nhóm.');
        }

        const apiResult = await api.undoFriendRequest(zid);
        results.push({
          jobId: job.id,
          ok: true,
          status: 'completed',
          statusLabel: 'Đã thu hồi lời mời',
          startedAt,
          sentAt: new Date().toISOString(),
          provider: 'local-service',
          apiResult,
        });
      } else if (actionType === 'accept_friend_request') {
        if (groupJob) {
          throw new Error('Chấp nhận lời mời không áp dụng cho nhóm.');
        }

        const apiResult = await api.acceptFriendRequest(zid);
        results.push({
          jobId: job.id,
          ok: true,
          status: 'completed',
          statusLabel: 'Đã chấp nhận lời mời',
          startedAt,
          sentAt: new Date().toISOString(),
          provider: 'local-service',
          apiResult,
        });
      } else if (actionType === 'reject_friend_request') {
        if (groupJob) {
          throw new Error('Từ chối lời mời không áp dụng cho nhóm.');
        }

        const apiResult = await api.rejectFriendRequest(zid);
        results.push({
          jobId: job.id,
          ok: true,
          status: 'completed',
          statusLabel: 'Đã từ chối lời mời',
          startedAt,
          sentAt: new Date().toISOString(),
          provider: 'local-service',
          apiResult,
        });
      } else if (actionType === 'pull_group') {
        if (groupJob) {
          throw new Error('Kéo nhóm không áp dụng cho hội thoại nhóm.');
        }

        const targetGroupId = normalizeThreadId(job?.targetGroupId, true);
        if (!targetGroupId || targetGroupId === '—') {
          throw new Error('Chưa chọn nhóm đích để mời thành viên.');
        }

        const apiResult = await api.addUserToGroup(zid, targetGroupId);
        const errorMembers = Array.isArray(apiResult?.errorMembers) ? apiResult.errorMembers : [];
        if (errorMembers.includes(zid)) {
          const errorMessage = apiResult?.error_data?.[zid]?.[0] || 'Không thể mời tài khoản đã chọn vào nhóm.';
          throw new Error(errorMessage);
        }

        results.push({
          jobId: job.id,
          ok: true,
          status: 'completed',
          statusLabel: `Đã mời vào ${job?.targetGroupName || 'nhóm'}`,
          startedAt,
          sentAt: new Date().toISOString(),
          provider: 'local-service',
          apiResult,
        });
      } else if (actionType === 'join_group') {
        const inviteLink = String(job?.inviteLink || job?.link || '').trim();
        if (!inviteLink) {
          throw new Error('Không tìm thấy link mời nhóm để tham gia.');
        }

        try {
          const apiResult = await api.joinGroupLink(inviteLink);
          results.push({
            jobId: job.id,
            ok: true,
            status: 'completed',
            statusLabel: 'Đã tham gia nhóm',
            startedAt,
            sentAt: new Date().toISOString(),
            provider: 'local-service',
            apiResult,
          });
        } catch (error) {
          const code = typeof error?.code === 'number' ? error.code : null;
          if (code === 178) {
            results.push({
              jobId: job.id,
              ok: true,
              status: 'skipped',
              statusLabel: 'Đã ở trong nhóm',
              startedAt,
              sentAt: new Date().toISOString(),
              provider: 'local-service',
              apiResult: null,
            });
          } else if (code === 240) {
            results.push({
              jobId: job.id,
              ok: true,
              status: 'pending',
              statusLabel: 'Đã gửi yêu cầu vào nhóm',
              startedAt,
              sentAt: new Date().toISOString(),
              provider: 'local-service',
              apiResult: null,
            });
          } else {
            throw error;
          }
        }
      } else if (actionType === 'mute' || actionType === 'unmute') {
        const threadType = groupJob ? ThreadType.Group : ThreadType.User;
        const params = actionType === 'mute'
          ? { action: MuteAction.MUTE, duration: MuteDuration.FOREVER }
          : { action: MuteAction.UNMUTE };

        const apiResult = await api.setMute(params, zid, threadType);
        results.push({
          jobId: job.id,
          ok: true,
          status: 'completed',
          statusLabel: actionType === 'mute' ? 'Đã tắt thông báo' : 'Đã bật thông báo',
          startedAt,
          sentAt: new Date().toISOString(),
          provider: 'local-service',
          apiResult,
        });
      } else {
        throw new Error(`Action không được hỗ trợ: ${actionType || 'unknown'}.`);
      }
    } catch (error) {
      results.push({
        jobId: job?.id,
        ok: false,
        status: 'failed',
        statusLabel:
          actionType === 'remove_friend'
            ? 'Xóa bạn thất bại'
            : actionType === 'leave_group'
              ? 'Rời nhóm thất bại'
              : actionType === 'undo_friend_request'
                ? 'Thu hồi lời mời thất bại'
                : actionType === 'accept_friend_request'
                  ? 'Chấp nhận lời mời thất bại'
                  : actionType === 'reject_friend_request'
                    ? 'Từ chối lời mời thất bại'
                    : actionType === 'pull_group'
                      ? 'Kéo nhóm thất bại'
                      : actionType === 'join_group'
                        ? 'Tham gia nhóm thất bại'
            : actionType === 'mute'
              ? 'Tắt thông báo thất bại'
              : actionType === 'unmute'
                ? 'Bật thông báo thất bại'
                : 'Thao tác thất bại',
        error: error instanceof Error ? error.message : 'Thực thi thao tác thất bại.',
        startedAt,
        failedAt: new Date().toISOString(),
        provider: 'local-service',
      });
    }

    if (index < jobs.length - 1) {
      const delayMs = getDelayMs(job?.delayWindow);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  writeJson(res, 200, {
    ok: true,
    provider: 'local-service',
    accepted: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  });
}

export async function handleSendBatch(req, res, body) {
  const account = body?.account;
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];

  if (!account) {
    writeJson(res, 400, { ok: false, error: 'Thiếu account để gửi tin.' });
    return;
  }

  if (!jobs.length) {
    writeJson(res, 400, { ok: false, error: 'Danh sách jobs rỗng.' });
    return;
  }

  const userAgent = getUserAgent(body, req);
  let api;
  try {
    ({ api } = await createApiClient(account, userAgent));
  } catch (error) {
    writeServiceLoginError(res, error);
    return;
  }

  const results = [];

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const groupJob = isGroupJob(job);
    const zid = normalizeThreadId(job?.zid, groupJob);
    const content = String(job?.content || '').trim();
    const startedAt = new Date().toISOString();

    if (!zid || zid === '—') {
      results.push({
        jobId: job?.id,
        ok: false,
        status: 'failed',
        statusLabel: 'Thiếu Zalo ID',
        error: 'Job không có Zalo ID hợp lệ.',
        startedAt,
        failedAt: new Date().toISOString(),
        provider: 'local-service',
      });
      continue;
    }

    if (!content) {
      results.push({
        jobId: job?.id,
        ok: false,
        status: 'failed',
        statusLabel: 'Thiếu nội dung',
        error: 'Job không có nội dung tin nhắn.',
        startedAt,
        failedAt: new Date().toISOString(),
        provider: 'local-service',
      });
      continue;
    }

    try {
      const threadType = groupJob ? ThreadType.Group : ThreadType.User;
      console.log(`[send] jobId=${job.id} zid=${zid} isGroup=${groupJob} threadType=${threadType} content="${content.slice(0, 50)}"`);
      const apiResult = await api.sendMessage(content, zid, threadType);
      console.log(`[send] jobId=${job.id} result:`, JSON.stringify(apiResult));
      results.push({
        jobId: job.id,
        ok: true,
        status: 'sent',
        statusLabel: 'Đã gửi qua local service',
        startedAt,
        sentAt: new Date().toISOString(),
        provider: 'local-service',
        apiResult,
      });
    } catch (error) {
      results.push({
        jobId: job?.id,
        ok: false,
        status: 'failed',
        statusLabel: 'Lỗi local service',
        error: error instanceof Error ? error.message : 'Gửi tin nhắn thất bại.',
        startedAt,
        failedAt: new Date().toISOString(),
        provider: 'local-service',
      });
    }

    if (index < jobs.length - 1) {
      const delayMs = getDelayMs(job?.delayWindow);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  writeJson(res, 200, {
    ok: true,
    provider: 'local-service',
    accepted: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  });
}