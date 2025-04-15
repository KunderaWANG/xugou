// 定期检查客户端状态的任务
import { getActiveAgents, setAgentInactive, getAgentById } from '../db/agent';
import { shouldSendNotification, sendNotification } from '../utils/notification';

interface AgentResult {
  id: number;
  name: string;
  status: string;
  updated_at: string;
}

export const checkAgentsStatus = async (env: any) => {
  try {
    console.log('定时任务: 检查客户端状态...');
    
    // 检查所有客户端的最后更新时间，如果超过3分钟没有更新，将状态设置为inactive
    const inactiveThreshold = 3 * 60 * 1000; // 2分钟，单位毫秒
    const now = new Date();
    
    // 查询所有状态为active的客户端
    const activeAgents = await getActiveAgents(env.DB);
    
    if (!activeAgents.results || activeAgents.results.length === 0) {
      console.log('定时任务: 没有活跃状态的客户端');
      return;
    }
    
    // 检查每个活跃客户端的最后更新时间
    for (const agent of activeAgents.results as AgentResult[]) {
      const lastUpdateTime = new Date(agent.updated_at);
      const timeDiff = now.getTime() - lastUpdateTime.getTime();
      
      // 如果超过3分钟没有更新状态，将客户端状态设置为inactive
      if (timeDiff > inactiveThreshold) {
        console.log(`定时任务: 客户端 ${agent.name} (ID: ${agent.id}) 超过2分钟未更新状态，设置为离线`);
        console.log(`最后更新时间: ${lastUpdateTime.toLocaleString('zh-CN')}`);
        console.log(`当前时间: ${now.toLocaleString('zh-CN')}`);
        console.log(`时间差: ${Math.floor(timeDiff / 1000)}秒`);
        
        // 更新客户端状态为inactive
        await setAgentInactive(env.DB, agent.id);
        
        // 处理通知
        await handleAgentOfflineNotification(env, agent.id, agent.name);
      }
    }
    
  } catch (error) {
    console.error('定时任务: 检查客户端状态出错:', error);
  }
};

/**
 * 处理客户端离线通知
 * @param env 环境变量
 * @param agentId 客户端ID
 * @param agentName 客户端名称
 */
async function handleAgentOfflineNotification(env: any, agentId: number, agentName: string) {
  try {
    // 检查是否需要发送通知
    const notificationCheck = await shouldSendNotification(
      env.DB,
      'agent',
      agentId,
      'online', // 上一个状态
      'offline' // 当前状态
    );
    
    if (!notificationCheck.shouldSend || notificationCheck.channels.length === 0) {
      console.log(`客户端 ${agentName} (ID: ${agentId}) 已离线，但不需要发送通知`);
      return;
    }
    
    console.log(`客户端 ${agentName} (ID: ${agentId}) 已离线，正在发送通知...`);
    
    // 获取客户端完整信息
    const agentData = await getAgentById(env.DB, agentId);
    
    if (!agentData) {
      console.error(`找不到客户端数据 (ID: ${agentId})`);
      return;
    }
    
    // 准备通知变量
    const variables = {
      name: agentName,
      status: 'offline',
      previous_status: 'online', // 添加previous_status变量
      time: new Date().toLocaleString('zh-CN'),
      hostname: agentData.hostname || '未知',
      ip_address: agentData.ip_address || '未知',
      os: agentData.os || '未知',
      error: '客户端连接超时',
      details: `主机名: ${agentData.hostname || '未知'}\nIP地址: ${agentData.ip_address || '未知'}\n操作系统: ${agentData.os || '未知'}\n最后连接时间: ${new Date(agentData.updated_at).toLocaleString('zh-CN')}`
    };
    
    // 发送通知
    const notificationResult = await sendNotification(
      env.DB,
      'agent',
      agentId,
      variables,
      notificationCheck.channels
    );
    
    if (notificationResult.success) {
      console.log(`客户端 ${agentName} (ID: ${agentId}) 离线通知发送成功`);
    } else {
      console.error(`客户端 ${agentName} (ID: ${agentId}) 离线通知发送失败`);
    }
  } catch (error) {
    console.error(`处理客户端离线通知时出错 (${agentName}, ID: ${agentId}):`, error);
  }
}

/**
 * 处理客户端阈值超出通知
 * 此函数可以单独调用，也可以在客户端上报数据时触发
 */
export async function handleAgentThresholdNotification(env: any, agentId: number, metricType: string, value: number) {
  try {
    // 获取客户端配置
    const agent = await getAgentById(env.DB, agentId);
    
    if (!agent) {
      console.error(`找不到客户端 (ID: ${agentId})`);
      return;
    }
    
    // 根据具体的指标类型
    let metricName = '';
    let threshold = 0;
    let shouldSend = false;
    
    // 查询特定设置
    const settings = await env.DB.prepare(
      `SELECT * FROM notification_settings WHERE target_type = ? AND target_id = ? AND enabled = 1`
    ).bind('agent', agentId).first();
    
    // 如果没有特定设置，查询全局设置
    const globalSettings = !settings ? await env.DB.prepare(
      `SELECT * FROM notification_settings WHERE target_type = ? AND enabled = 1`
    ).bind('global-agent').first() : null;
    
    // 使用特定设置或全局设置
    const finalSettings = settings || globalSettings;
    
    if (!finalSettings) {
      console.log(`客户端 ${agent.name} (ID: ${agentId}) 没有可用的通知设置，不发送通知`);
      return;
    }
    
    // 根据指标类型检查阈值
    switch (metricType) {
      case 'cpu':
        metricName = 'CPU使用率';
        threshold = finalSettings.cpu_threshold;
        shouldSend = finalSettings.on_cpu_threshold && value >= threshold;
        break;
      case 'memory':
        metricName = '内存使用率';
        threshold = finalSettings.memory_threshold;
        shouldSend = finalSettings.on_memory_threshold && value >= threshold;
        break;
      case 'disk':
        metricName = '磁盘使用率';
        threshold = finalSettings.disk_threshold;
        shouldSend = finalSettings.on_disk_threshold && value >= threshold;
        break;
      default:
        return; // 不支持的指标类型
    }
    
    if (!shouldSend) {
      return;
    }
    
    // 获取通知渠道
    let channels = [];
    try {
      channels = JSON.parse(finalSettings.channels);
    } catch (e) {
      console.error(`解析通知渠道失败 (${agent.name}, ID: ${agentId}):`, e);
      return;
    }
    
    if (channels.length === 0) {
      console.log(`客户端 ${agent.name} (ID: ${agentId}) 没有配置通知渠道，不发送通知`);
      return;
    }
    
    console.log(`客户端 ${agent.name} (ID: ${agentId}) ${metricName}超过阈值(${value.toFixed(2)}% >= ${threshold}%)，发送通知...`);
    
    // 准备通知变量
    const variables = {
      name: agent.name,
      status: `${metricName}告警`,
      previous_status: 'normal', // 添加previous_status变量
      time: new Date().toLocaleString('zh-CN'),
      hostname: agent.hostname || '未知',
      ip_address: agent.ip_address || '未知',
      os: agent.os || '未知',
      error: `${metricName}(${value.toFixed(2)}%)超过阈值(${threshold}%)`,
      details: `${metricName}: ${value.toFixed(2)}%\n阈值: ${threshold}%\n主机名: ${agent.hostname || '未知'}\nIP地址: ${agent.ip_address || '未知'}\n操作系统: ${agent.os || '未知'}`
    };
    
    // 发送通知
    const notificationResult = await sendNotification(
      env.DB,
      'agent',
      agentId,
      variables,
      channels
    );
    
    if (notificationResult.success) {
      console.log(`客户端 ${agent.name} (ID: ${agentId}) ${metricName}告警通知发送成功`);
    } else {
      console.error(`客户端 ${agent.name} (ID: ${agentId}) ${metricName}告警通知发送失败`);
    }
  } catch (error) {
    console.error(`处理客户端阈值通知时出错 (ID: ${agentId}):`, error);
  }
} 
