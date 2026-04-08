/**
 * 阿里云制品仓库配置文件
 */
module.exports = {
  // API基础配置
  baseUrl:
    "https://packages.aliyun.com/api/protocol/63b05092aa32314b151f0761/generic/flow_generic_repo",

  // 认证信息
  auth: {
    username: "63b05082da874cca7225a283",
    password: ")96v6beCs4D)",
  },

  // API端点
  endpoints: {
    upload: "/files/{filePath}",
    download: "/files/{filePath}",
    getDownloadLink: "/files/{filePath}",
  },
};
