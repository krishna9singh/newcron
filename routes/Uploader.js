const express = require("express");
const router = express.Router();
const multer = require("multer");
const Post = require("../models/post");
const Interest = require("../models/Interest");
const User = require("../models/userAuth");
const Topic = require("../models/topic");
const Community = require("../models/community");
const Tag = require("../models/Tags");

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

const uuid = require("uuid").v4;
require("dotenv").config();

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const POST_BUCKET = process.env.POST_BUCKET;

const s3 = new S3Client({
  region: "ap-south-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
  },
});

const directoryPath = "./content/h";

function findCorrespondingFile({ fileName, extensions }) {
  for (const e of extensions) {
    const file = path.join(directoryPath, `${fileName}.${e}`);
    if (fs.existsSync(file)) {
      return file;
    } else {
      null;
    }
  }
}

function findCorrespondingTextFile(f) {
  const parsedPath = path.parse(f);
  const fileNameWithoutExtension = parsedPath.name;
  const textFileName = `${fileNameWithoutExtension}.txt`;
  const textFilePath = path.join(parsedPath.dir, textFileName);
  return textFilePath;
}

function getFileExtension(filePath) {
  return path.extname(filePath).toLowerCase();
}

router.post("/upcom", async (req, res) => {
  fs.readdir(directoryPath, (err, files) => {
    if (err) {
      console.error("Error reading directory:", err);
      return;
    }

    const textFiles = files.filter((file) => /\.txt$/i.test(file));
    const fileContents = [];

    textFiles.forEach((file) => {
      const filePath = path.join(directoryPath, file);
      const content = fs.readFileSync(filePath, "utf8");
      const normalizedText = content.replace(/(\n|\+)/g, " ");
      const textWithoutHashtags = normalizedText.replace(/#[^\s#]+/g, "");

      const hashtags = content.match(/#[^\s#]+/g);
      fileContents.push({ fileName: file, textWithoutHashtags, hashtags });

      const filename = file.split(".")[0];

      const extensions = ["mp4", "jpg"];
      const present = findCorrespondingFile({
        fileName: filename,
        extensions: extensions,
      });
      console.log(typeof present);
    });
  });
});

async function readAndProcessFiles(directoryPath) {
  fs.readdir(directoryPath, (err, files) => {
    if (err) {
      console.error("Error reading directory:", err);
      return;
    }
    let allfiles = [];

    //checking for all files
    files.forEach((file) => {
      const filePath = path.join(directoryPath, file);

      // Check if the item is req. file
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        const filename = file.split(".")[0];
        const extensions = ["mp4", "jpg"];
        const present = findCorrespondingFile({
          fileName: filename,
          extensions: extensions,
        });

        if (present) {
          const ext = getFileExtension(present);
          let textfile = findCorrespondingTextFile(present);
          allfiles.push({ file: present, textfile: textfile, extension: ext });
        }
      }
    });

    allfiles.reverse();
    let i = 0;
    while (i < allfiles.length) {
      let fileEntry = allfiles[i];

      let filePath = fileEntry.file;
      let textFilePath = fileEntry.textfile;

      if (fs.existsSync(filePath) && fs.existsSync(textFilePath)) {
        if (filePath.endsWith(".json.xz")) {
          fs.unlinkSync(filePath);
          fs.unlinkSync(textFilePath);
        } else {
          const content = fs.readFileSync(textFilePath, "utf8");
          const normalizedText = content.replace(/(\n|\+)/g, " ");
          const textWithoutHashtags = normalizedText.replace(/#[^\s#]+/g, "");
          const hashtags = content.match(/#[^\s#]+/g);

          console.log(
            textWithoutHashtags,
            //hashtags,
            filePath,
            fileEntry.extension,
            filePath.endsWith(".txt")
          );
          // fs.unlinkSync(filePath);
          // fs.unlinkSync(textFilePath);
          if (filePath) {
            uploadPostToS3({
              file: filePath,
              textWithoutHashtags,
              hashtags,
              textFilePath,
              extension: fileEntry.extension,
            });
          }
        }
        break;
      } else {
        i++;
        console.error(
          "Either file or text file does not exist:",
          filePath,
          textFilePath
        );
      }
    }
  });
}

// Function to upload post to S3
async function uploadPostToS3({
  file,
  textFilePath,
  extension,
  textWithoutHashtags,
  hashtags,
}) {
  console.log("Uploading file:", file);

  let comId = "65fff09cb8c3f66de8353379";
  const community = await Community.findById(comId);
  let sender = "65ffef7db8c3f66de83403ce";
  const user = await User.findById(sender);
  let topic = "65fff09cb8c3f66de835337b";

  try {
    let pos = [];

    // Uploading files to S3
    const uuidString = uuid();
    const objectName = `${Date.now()}_${uuidString}${extension}`;

    const result = await s3.send(
      new PutObjectCommand({
        Bucket: POST_BUCKET,
        Key: objectName,
        Body: fs.readFileSync(file),
      })
    );

    let contentType;
    if (extension === ".mp4" || extension === ".avi" || extension === ".mov") {
      contentType = "video/mp4";
    } else if (
      extension === ".jpg" ||
      extension === ".jpeg" ||
      extension === ".png"
    ) {
      contentType = "image/jpg";
    } else {
      contentType = "image/jpg";
    }

    pos.push({ content: objectName, type: contentType });

    const post = new Post({
      title: textWithoutHashtags,
      community: comId,
      sender: sender,
      post: pos,
      tags: hashtags,
      topicId: topic,
      date: new Date(),
    });
    const savedpost = await post.save();

    //updating tags and interests
    const int = await Interest.findOne({ title: "Beauty & Fashion" });

    for (let i = 0; i < hashtags?.length; i++) {
      const t = await Tag.findOne({ title: hashtags[i].toLowerCase() });

      if (t) {
        await Tag.updateOne(
          { _id: t._id },
          { $inc: { count: 1 }, $addToSet: { post: post._id } }
        );
        if (int) {
          await Interest.updateOne(
            { _id: int._id },
            { $inc: { count: 1 }, $addToSet: { post: post._id, tags: t._id } }
          );
        }
      } else {
        const newtag = new Tag({
          title: hashtags[i].toLowerCase(),
          post: post._id,
          count: 1,
        });
        await newtag.save();
        if (int) {
          await Interest.updateOne(
            { _id: int._id },
            {
              $inc: { count: 1 },
              $addToSet: { post: post._id, tags: newtag._id },
            }
          );
        }
      }
    }

    await Community.updateOne(
      { _id: comId },
      { $push: { posts: savedpost._id }, $inc: { totalposts: 1 } }
    );
    await Topic.updateOne(
      { _id: topic },
      { $push: { posts: savedpost._id }, $inc: { postcount: 1 } }
    );
    fs.unlinkSync(file);
    fs.unlinkSync(textFilePath);
    let tokens = [];

    // if (community.members.length > 0) {
    //   for (let u of community.members) {
    //     const user = await User.findById(u);

    //     if (user.notificationtoken && user._id.toString()) {
    //       tokens.push(user.notificationtoken);
    //     }
    //   }

    //   const timestamp = `${new Date()}`;
    //   const msg = {
    //     notification: {
    //       title: `${community.title} - Posted!`,
    //       body: `${post.title}`,
    //     },
    //     data: {
    //       screen: "CommunityChat",
    //       sender_fullname: `${user?.fullname}`,
    //       sender_id: `${user?._id}`,
    //       text: `${post.title}`,
    //       comId: `${community?._id}`,
    //       createdAt: `${timestamp}`,
    //     },
    //     tokens: tokens,
    //   };

    //   await admin
    //     .messaging()
    //     .sendMulticast(msg)
    //     .then((response) => {
    //       console.log("Successfully sent message");
    //     })
    //     .catch((error) => {
    //       console.log("Error sending message:", error);
    //     });
    // }

    console.log("Post uploaded and saved");
  } catch (error) {
    console.error("Error uploading post:", error);
  }
}

// Every 22 hours
cron.schedule("0 */8 * * *", () => {
  console.log("Running file reading and processing task...");
  readAndProcessFiles(directoryPath);
});

module.exports = router;
